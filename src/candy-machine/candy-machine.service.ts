import { Injectable, NotFoundException } from '@nestjs/common';
import { Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { PrismaService } from 'nestjs-prisma';
import {
  Metaplex,
  toBigNumber,
  TransactionBuilder,
  DefaultCandyGuardSettings,
  CandyMachine,
  JsonMetadata,
  getMerkleRoot,
  toDateTime,
  CreateCandyMachineInput,
  WRAPPED_SOL_MINT,
} from '@metaplex-foundation/js';
import { s3toMxFile } from '../utils/files';
import {
  constructChangeComicStateTransaction,
  constructMintOneTransaction,
  initializeRecordAuthority,
} from './instructions';
import { HeliusService } from '../webhooks/helius/helius.service';
import { CandyMachineReceiptParams } from './dto/candy-machine-receipt-params.dto';
import { chunk } from 'lodash';
import * as bs58 from 'bs58';
import {
  MAX_METADATA_LEN,
  CREATOR_ARRAY_START,
  D_PUBLISHER_SYMBOL,
  HUNDRED_PERCENT_TAX,
  D_READER_FRONTEND_URL,
  MAX_SIGNATURES_PERCENT,
  MIN_SIGNATURES,
  BOT_TAX,
  FREEZE_NFT_DAYS,
  DAY_SECONDS,
  RARITY_MAP,
  AUTHORITY_GROUP_LABEL,
  PUBLIC_GROUP_LABEL,
  PUBLIC_GROUP_MINT_LIMIT_ID,
} from '../constants';
import { solFromLamports } from '../utils/helpers';
import { MetdataFile, metaplex, writeFiles } from '../utils/metaplex';
import {
  findDefaultCover,
  getStatefulCoverName,
  validateComicIssueCMInput,
} from '../utils/comic-issue';
import { ComicIssueCMInput } from '../comic-issue/dto/types';
import { GuardGroup, RarityCoverFiles } from '../types/shared';
import {
  generatePropertyName,
  uploadItemMetadata,
} from '../utils/nft-metadata';
import {
  ComicStateArgs,
  PROGRAM_ID as COMIC_VERSE_ID,
} from 'dreader-comic-verse';
import { DarkblockService } from './darkblock.service';
import { PUB_AUTH_TAG, pda } from './instructions/pda';
import { CandyMachineParams } from './dto/candy-machine-params.dto';
import { Prisma } from '@prisma/client';
import { CandyMachineGroupSettings, GuardParams } from './dto/types';
import { constructCandyMachineTransaction } from './instructions/initialize-candy-machine';
import { constructThawTransaction } from './instructions/route';

type JsonMetadataCreators = JsonMetadata['properties']['creators'];

@Injectable()
export class CandyMachineService {
  private readonly metaplex: Metaplex;

  constructor(
    private readonly prisma: PrismaService,
    private readonly heliusService: HeliusService,
    private readonly darkblockService: DarkblockService,
  ) {
    this.metaplex = metaplex;
  }

  async findMintedNfts(candyMachineAddress: string) {
    const candyMachineId = new PublicKey(candyMachineAddress);
    const candyMachineCreator = PublicKey.findProgramAddressSync(
      [Buffer.from('candy_machine'), candyMachineId.toBuffer()],
      this.metaplex.programs().getCandyMachine().address,
    );

    return await this.getMintAddresses(candyMachineCreator[0]);
  }

  async getMintAddresses(firstCreatorAddress: PublicKey) {
    const metadataAccounts = await this.metaplex.connection.getProgramAccounts(
      this.metaplex.programs().getTokenMetadata().address,
      {
        // The mint address is located at byte 33 and lasts for 32 bytes.
        dataSlice: { offset: 33, length: 32 },
        filters: [
          // Only get Metadata accounts.
          { dataSize: MAX_METADATA_LEN },
          // Filter using the first creator.
          {
            memcmp: {
              offset: CREATOR_ARRAY_START,
              bytes: firstCreatorAddress.toBase58(),
            },
          },
        ],
      },
    );

    return metadataAccounts.map((metadataAccountInfo) =>
      bs58.encode(metadataAccountInfo.account.data),
    );
  }

  async getComicIssueCovers(comicIssue: ComicIssueCMInput) {
    const statelessCoverPromises = comicIssue.statelessCovers.map((cover) =>
      s3toMxFile(cover.image),
    );
    const statelessCovers = await Promise.all(statelessCoverPromises);

    const rarityCoverFiles: RarityCoverFiles = {} as RarityCoverFiles;
    const statefulCoverPromises = comicIssue.statefulCovers.map(
      async (cover) => {
        const file = await s3toMxFile(cover.image, getStatefulCoverName(cover));
        const property = generatePropertyName(cover.isUsed, cover.isSigned);
        const value = {
          ...rarityCoverFiles[cover.rarity],
          [property]: file,
        };
        rarityCoverFiles[cover.rarity] = value;
        return file;
      },
    );
    const statefulCovers = await Promise.all(statefulCoverPromises);

    return { statefulCovers, statelessCovers, rarityCoverFiles };
  }

  async initializeGuardAccounts(
    candyMachine: CandyMachine<DefaultCandyGuardSettings>,
    freezePeriod?: number,
  ) {
    await this.metaplex.candyMachines().callGuardRoute({
      candyMachine,
      guard: 'freezeSolPayment',
      settings: {
        path: 'initialize',
        period: (freezePeriod ?? FREEZE_NFT_DAYS) * DAY_SECONDS,
        candyGuardAuthority: this.metaplex.identity(),
      },
      group: AUTHORITY_GROUP_LABEL,
    });
  }

  async createComicIssueCM(
    comicIssue: ComicIssueCMInput,
    comicName: string,
    guardParams: GuardParams,
  ) {
    validateComicIssueCMInput(comicIssue);

    const creatorAddress = comicIssue.creatorAddress;
    const creatorBackupAddress = comicIssue.creatorBackupAddress;
    const royaltyWallets: JsonMetadataCreators = comicIssue.royaltyWallets;

    const { statefulCovers, statelessCovers, rarityCoverFiles } =
      await this.getComicIssueCovers(comicIssue);

    const cover = findDefaultCover(comicIssue.statelessCovers);
    const coverImage = await s3toMxFile(cover.image);

    // if Collection NFT already exists - use it, otherwise create a fresh one
    let collectionNftAddress: PublicKey;
    const collectionNft = await this.prisma.collectionNft.findUnique({
      where: { comicIssueId: comicIssue.id },
    });

    const candyMachineKey = Keypair.generate();

    let darkblockId = '';
    if (collectionNft) {
      collectionNftAddress = new PublicKey(collectionNft.address);
    } else {
      let darkblockMetadataFile: MetdataFile;
      if (comicIssue.pdf) {
        darkblockId = await this.darkblockService.mintDarkblock(
          comicIssue.pdf,
          comicIssue.description,
          creatorAddress,
        );
        darkblockMetadataFile = {
          type: 'Darkblock',
          uri: darkblockId,
        };
      }

      const { uri: collectionNftUri } = await this.metaplex
        .nfts()
        .uploadMetadata({
          name: comicIssue.title,
          symbol: D_PUBLISHER_SYMBOL,
          description: comicIssue.description,
          seller_fee_basis_points: HUNDRED_PERCENT_TAX,
          image: coverImage,
          external_url: D_READER_FRONTEND_URL,
          properties: {
            creators: [
              {
                address: this.metaplex.identity().publicKey.toBase58(),
                share: HUNDRED_PERCENT_TAX,
              },
            ],
            files: [
              ...writeFiles(coverImage, ...statefulCovers, ...statelessCovers),
              darkblockMetadataFile,
            ],
          },
        });

      const { nft: newCollectionNft } = await this.metaplex.nfts().create({
        uri: collectionNftUri,
        name: comicIssue.title,
        sellerFeeBasisPoints: HUNDRED_PERCENT_TAX,
        symbol: D_PUBLISHER_SYMBOL,
        isCollection: true,
      });

      await this.prisma.collectionNft.create({
        data: {
          address: newCollectionNft.address.toBase58(),
          name: newCollectionNft.name,
          comicIssue: { connect: { id: comicIssue.id } },
        },
      });
      collectionNftAddress = newCollectionNft.address;
    }
    const recordAuthorityPda = await pda(
      [Buffer.from(PUB_AUTH_TAG), collectionNftAddress.toBuffer()],
      COMIC_VERSE_ID,
    );
    const recordAuthority = await this.metaplex.connection.getAccountInfo(
      recordAuthorityPda,
    );

    if (!recordAuthority) {
      await initializeRecordAuthority(
        this.metaplex,
        collectionNftAddress,
        new PublicKey(creatorAddress),
        new PublicKey(creatorBackupAddress),
        MAX_SIGNATURES_PERCENT,
        MIN_SIGNATURES,
      );
    }

    const creators: CreateCandyMachineInput['creators'] = royaltyWallets.map(
      (wallet) => ({
        address: new PublicKey(wallet.address),
        share: wallet.share,
      }),
    );

    const { startDate, endDate, mintLimit, freezePeriod, mintPrice, supply } =
      guardParams;
    const candyMachineTx = await constructCandyMachineTransaction(
      this.metaplex,
      {
        candyMachine: candyMachineKey,
        authority: this.metaplex.identity().publicKey,
        collection: {
          address: collectionNftAddress,
          updateAuthority: this.metaplex.identity(),
        },
        symbol: D_PUBLISHER_SYMBOL,
        maxEditionSupply: toBigNumber(0),
        isMutable: true,
        sellerFeeBasisPoints: comicIssue.sellerFeeBasisPoints,
        itemsAvailable: toBigNumber(supply),
        guards: {
          botTax: {
            lamports: solFromLamports(BOT_TAX),
            lastInstruction: true,
          },
        },
        groups: [
          {
            label: AUTHORITY_GROUP_LABEL,
            guards: {
              allowList: {
                merkleRoot: getMerkleRoot([
                  this.metaplex.identity().publicKey.toString(),
                ]),
              },
              solPayment: {
                amount: solFromLamports(0),
                destination: this.metaplex.identity().publicKey,
              },
            },
          },
          {
            label: PUBLIC_GROUP_LABEL,
            guards: {
              startDate: {
                date: toDateTime(startDate),
              },
              endDate: {
                date: toDateTime(endDate),
              },
              freezeSolPayment: {
                amount: solFromLamports(mintPrice),
                destination: this.metaplex.identity().publicKey,
              },
              mintLimit: mintLimit
                ? {
                    id: PUBLIC_GROUP_MINT_LIMIT_ID,
                    limit: mintLimit,
                  }
                : undefined,
            },
          },
        ],
        creators: [
          {
            address: this.metaplex.identity().publicKey,
            share: 0,
          },
          ...creators,
        ],
      },
    );
    await sendAndConfirmTransaction(metaplex.connection, candyMachineTx, [
      metaplex.identity(),
      candyMachineKey,
    ]);

    const candyMachine = await this.metaplex
      .candyMachines()
      .findByAddress({ address: candyMachineKey.publicKey });
    await this.initializeGuardAccounts(candyMachine, freezePeriod);
    const authorityPda = this.metaplex
      .candyMachines()
      .pdas()
      .authority({ candyMachine: candyMachine.address })
      .toString();

    await this.prisma.candyMachine.create({
      data: {
        address: candyMachine.address.toBase58(),
        mintAuthorityAddress: candyMachine.mintAuthorityAddress.toBase58(),
        collectionNftAddress: candyMachine.collectionMintAddress.toBase58(),
        authorityPda,
        itemsAvailable: candyMachine.itemsAvailable.toNumber(),
        itemsMinted: candyMachine.itemsMinted.toNumber(),
        itemsRemaining: candyMachine.itemsRemaining.toNumber(),
        itemsLoaded: candyMachine.itemsLoaded,
        isFullyLoaded: candyMachine.isFullyLoaded,
        supply,
        groups: {
          create: {
            displayLabel: PUBLIC_GROUP_LABEL,
            wallets: undefined,
            label: PUBLIC_GROUP_LABEL,
            startDate,
            endDate,
            mintPrice: mintPrice,
            mintLimit,
            supply,
            splTokenAddress: WRAPPED_SOL_MINT.toBase58(),
          },
        },
      },
    });
    const items = await uploadItemMetadata(
      metaplex,
      comicIssue,
      collectionNftAddress,
      comicName,
      royaltyWallets,
      statelessCovers.length,
      darkblockId,
      supply,
      rarityCoverFiles,
    );

    const INSERT_CHUNK_SIZE = 8;
    const itemChunks = chunk(items, INSERT_CHUNK_SIZE);
    let iteration = 0;
    const transactionBuilders: TransactionBuilder[] = [];
    for (const itemsChunk of itemChunks) {
      console.info(
        `Inserting items ${iteration * INSERT_CHUNK_SIZE}-${
          (iteration + 1) * INSERT_CHUNK_SIZE - 1
        } `,
      );
      const transactionBuilder = this.metaplex
        .candyMachines()
        .builders()
        .insertItems({
          candyMachine,
          index: iteration * INSERT_CHUNK_SIZE,
          items: itemsChunk,
        });
      transactionBuilders.push(transactionBuilder);
      iteration = iteration + 1;
    }

    const latestBlockhash = await this.metaplex.connection.getLatestBlockhash();
    await Promise.all(
      transactionBuilders.map((transactionBuilder) => {
        const transaction = transactionBuilder.toTransaction(latestBlockhash);
        return sendAndConfirmTransaction(
          this.metaplex.connection,
          transaction,
          [this.metaplex.identity()],
        );
      }),
    );

    this.heliusService.subscribeTo(candyMachine.address.toBase58());
    return await this.metaplex.candyMachines().refresh(candyMachine);
  }

  async updateCandyMachine(
    candyMachineAddress: PublicKey,
    groups?: GuardGroup[],
    guards?: Partial<DefaultCandyGuardSettings>,
  ) {
    const candyMachine = await this.metaplex
      .candyMachines()
      .findByAddress({ address: candyMachineAddress });
    await this.metaplex.candyMachines().update({
      candyMachine,
      groups,
      guards,
    });
  }

  async createMintTransaction(
    feePayer: PublicKey,
    candyMachineAddress: PublicKey,
    label: string,
    mintCount?: number,
  ) {
    const transactions: Promise<string>[] = [];
    for (let i = 0; i < mintCount; i++) {
      transactions.push(
        this.createMintOneTransaction(feePayer, candyMachineAddress, label),
      );
    }
    return await Promise.all(transactions);
  }

  async createMintOneTransaction(
    feePayer: PublicKey,
    candyMachineAddress: PublicKey,
    label: string,
  ) {
    const allowList = await this.findAllowList(
      candyMachineAddress.toString(),
      label,
    );
    return await constructMintOneTransaction(
      this.metaplex,
      feePayer,
      candyMachineAddress,
      label,
      allowList,
    );
  }

  async createChangeComicStateTransaction(
    mint: PublicKey,
    feePayer: PublicKey,
    newState: ComicStateArgs,
  ) {
    const {
      ownerAddress,
      collectionNftAddress,
      candyMachineAddress,
      metadata,
    } = await this.prisma.nft.findUnique({
      where: { address: mint.toString() },
      include: { metadata: true },
    });

    const owner = new PublicKey(ownerAddress);
    const collectionMintPubKey = new PublicKey(collectionNftAddress);
    const candyMachinePubKey = new PublicKey(candyMachineAddress);
    const numberedRarity = RARITY_MAP[metadata.rarity];

    return await constructChangeComicStateTransaction(
      this.metaplex,
      owner,
      collectionMintPubKey,
      candyMachinePubKey,
      numberedRarity,
      mint,
      feePayer,
      newState,
    );
  }

  async thawFrozenNft(
    candyMachineAddress: PublicKey,
    nftMint: PublicKey,
    nftOwner: PublicKey,
    guard: string,
    label: string,
  ) {
    const transaction = await constructThawTransaction(
      this.metaplex,
      candyMachineAddress,
      nftMint,
      nftOwner,
      guard,
      label,
    );
    await sendAndConfirmTransaction(this.metaplex.connection, transaction, [
      this.metaplex.identity(),
    ]);
  }

  async unlockFunds(
    candyMachineAddress: PublicKey,
    guard: string,
    group: string,
  ) {
    const candyMachine = await this.metaplex
      .candyMachines()
      .findByAddress({ address: candyMachineAddress });
    await this.metaplex.candyMachines().callGuardRoute({
      candyMachine,
      guard,
      group,
      settings: {
        path: 'unlockFunds',
        candyGuardAuthority: this.metaplex.identity(),
      },
    });
  }

  async find(query: CandyMachineParams) {
    const address = query.candyMachineAddress;
    const candyMachine = await this.prisma.candyMachine.findUnique({
      where: { address },
      include: { groups: true },
    });
    if (!candyMachine) {
      throw new NotFoundException(
        `Candy Machine with address ${address} does not exist`,
      );
    }

    const groups: CandyMachineGroupSettings[] = await Promise.all(
      candyMachine.groups.map(
        async (group): Promise<CandyMachineGroupSettings> => {
          const { itemsMinted, displayLabel, isEligible, walletItemsMinted } =
            await this.getMintCount(
              query.candyMachineAddress,
              group.label,
              query.walletAddress,
            );
          return {
            ...group,
            itemsMinted,
            displayLabel,
            walletStats: {
              isEligible,
              itemsMinted: walletItemsMinted,
            },
          };
        },
      ),
    );
    return { ...candyMachine, groups };
  }

  async findReceipts(query: CandyMachineReceiptParams) {
    const receipts = await this.prisma.candyMachineReceipt.findMany({
      where: { candyMachineAddress: query.candyMachineAddress },
      include: { nft: true, buyer: { include: { user: true } } },
      orderBy: { timestamp: 'desc' },
      skip: query.skip,
      take: query.take,
    });

    return receipts;
  }

  async addCandyMachineGroup(candyMachineAddress: string, params: GuardParams) {
    const {
      displayLabel,
      label,
      startDate,
      endDate,
      splTokenAddress,
      mintPrice,
      mintLimit,
      supply,
    } = params;
    await this.prisma.candyMachineGroup.create({
      data: {
        candyMachine: {
          connect: {
            address: candyMachineAddress,
          },
        },
        displayLabel,
        wallets: undefined,
        label,
        startDate,
        endDate,
        splTokenAddress,
        mintPrice,
        mintLimit,
        supply,
      },
    });
  }

  async addAllowList(
    candyMachineAddress: string,
    allowList: string[],
    label: string,
  ) {
    const wallets: Prisma.WalletCandyMachineGroupCreateNestedManyWithoutCandyMachineGroupInput =
      {
        create: allowList.map((address) => {
          return {
            wallet: {
              connectOrCreate: {
                where: { address },
                create: { address },
              },
            },
          };
        }),
      };

    return await this.prisma.candyMachineGroup.update({
      where: {
        label_candyMachineAddress: { label, candyMachineAddress },
      },
      data: { wallets },
      include: { wallets: true },
    });
  }

  async findAllowList(candyMachineAddress: string, label: string) {
    const allowList = await this.prisma.candyMachineGroup.findFirst({
      where: { candyMachineAddress, label },
      include: { wallets: true },
    });
    return allowList
      ? allowList.wallets.map((item) => item.walletAddress)
      : undefined;
  }

  async getMintCount(
    candyMachineAddress: string,
    label: string,
    walletAddress: string,
  ): Promise<{
    itemsMinted: number;
    walletItemsMinted: number;
    displayLabel: string;
    isEligible: boolean;
  }> {
    const receipts = await this.prisma.candyMachineReceipt.findMany({
      where: { candyMachineAddress, label },
    });

    const receiptsFromBuyer = receipts.filter(
      (receipt) => receipt.buyerAddress === walletAddress,
    );

    let displayLabel = PUBLIC_GROUP_LABEL;
    let isEligible = true;

    if (label !== PUBLIC_GROUP_LABEL) {
      const group = await this.prisma.candyMachineGroup.findFirst({
        where: { candyMachineAddress, label },
        include: { wallets: true },
      });

      displayLabel = group.displayLabel;
      isEligible = !!group.wallets.find(
        (groupWallets) => groupWallets.walletAddress == walletAddress,
      );
    }

    return {
      itemsMinted: receipts.length,
      walletItemsMinted: receiptsFromBuyer.length,
      displayLabel,
      isEligible,
    };
  }
}
