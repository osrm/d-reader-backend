import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import {
  CreateCreatorDto,
  CreateCreatorFilesDto,
} from '../creator/dto/create-creator.dto';
import { UpdateCreatorDto } from '../creator/dto/update-creator.dto';
import { Creator, Genre } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { subDays } from 'date-fns';
import { CreatorFilterParams } from './dto/creator-filter-params.dto';
import { WalletCreatorService } from './wallet-creator.service';
import { s3Service } from '../aws/s3.service';
import { PickFields } from '../types/shared';
import { CreatorStats } from 'src/comic/types/creator-stats';
import { getCreatorsQuery } from './creator.queries';
import { getRandomFloatOrInt } from '../utils/helpers';

const getS3Folder = (slug: string) => `creators/${slug}/`;
type CreatorFileProperty = PickFields<Creator, 'avatar' | 'banner' | 'logo'>;

@Injectable()
export class CreatorService {
  constructor(
    private readonly s3: s3Service,
    private readonly prisma: PrismaService,
    private readonly walletCreatorService: WalletCreatorService,
  ) {}

  async create(
    walletAddress: string,
    createCreatorDto: CreateCreatorDto,
    createCreatorFilesDto: CreateCreatorFilesDto,
  ) {
    const { slug, ...rest } = createCreatorDto;

    let creator: Creator;
    try {
      creator = await this.prisma.creator.create({
        data: { ...rest, slug, walletAddress },
      });
    } catch {
      throw new BadRequestException('Bad creator data');
    }

    const { avatar, banner, logo } = createCreatorFilesDto;

    let avatarKey: string, bannerKey: string, logoKey: string;
    try {
      const s3Folder = getS3Folder(slug);
      if (avatar)
        avatarKey = await this.s3.uploadFile(s3Folder, avatar, 'avatar');
      if (banner)
        bannerKey = await this.s3.uploadFile(s3Folder, banner, 'banner');
      if (logo) logoKey = await this.s3.uploadFile(s3Folder, logo, 'logo');
    } catch {
      throw new BadRequestException('Malformed file upload');
    }

    creator = await this.prisma.creator.update({
      where: { id: creator.id },
      data: {
        avatar: avatarKey,
        banner: bannerKey,
        logo: logoKey,
      },
    });

    return creator;
  }

  async findAll(query: CreatorFilterParams) {
    const creators = await this.prisma.$queryRaw<
      Array<Creator & { genres: Genre[] } & CreatorStats>
    >(getCreatorsQuery(query));
    return creators.map((creator) => {
      return {
        ...creator,
        stats: {
          totalVolume: getRandomFloatOrInt(1, 1000),
          followersCount: Number(creator.followersCount),
          comicIssuesCount: Number(creator.comicIssuesCount),
        },
      };
    });
  }

  async findOne(slug: string, walletAddress: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { slug },
    });

    if (!creator) {
      throw new NotFoundException(`Creator ${slug} does not exist`);
    }

    const { stats, myStats } = await this.walletCreatorService.aggregateAll(
      slug,
      walletAddress,
    );

    return { ...creator, stats, myStats };
  }

  async update(slug: string, updateCreatorDto: UpdateCreatorDto) {
    try {
      const updatedCreator = await this.prisma.creator.update({
        where: { slug },
        data: updateCreatorDto,
      });

      return updatedCreator;
    } catch {
      throw new NotFoundException(`Creator ${slug} does not exist`);
    }
  }

  async updateFile(
    slug: string,
    file: Express.Multer.File,
    field: CreatorFileProperty,
  ) {
    let creator: Creator;
    try {
      creator = await this.prisma.creator.findUnique({ where: { slug } });
    } catch {
      throw new NotFoundException(`Creator ${slug} does not exist`);
    }

    const s3Folder = getS3Folder(slug);
    const oldFileKey = creator[field];
    const newFileKey = await this.s3.uploadFile(s3Folder, file, 'field');

    try {
      creator = await this.prisma.creator.update({
        where: { slug },
        data: { [file.fieldname]: newFileKey },
      });
    } catch {
      await this.s3.deleteObject(newFileKey);
      throw new BadRequestException('Malformed file upload');
    }

    await this.s3.garbageCollectOldFile(newFileKey, oldFileKey);
    return creator;
  }

  async pseudoDelete(slug: string) {
    try {
      return await this.prisma.creator.update({
        where: { slug },
        data: { deletedAt: new Date() },
      });
    } catch {
      throw new NotFoundException(`Creator ${slug} does not exist`);
    }
  }

  async pseudoRecover(slug: string) {
    try {
      return await this.prisma.creator.update({
        where: { slug },
        data: { deletedAt: null },
      });
    } catch {
      throw new NotFoundException(`Creator ${slug} does not exist`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async clearCreatorsQueuedForRemoval() {
    const where = { where: { deletedAt: { lte: subDays(new Date(), 30) } } };
    const creatorsToRemove = await this.prisma.creator.findMany(where);
    await this.prisma.creator.deleteMany(where);

    for (const creator of creatorsToRemove) {
      const s3Folder = getS3Folder(creator.slug);
      await this.s3.deleteFolder(s3Folder);
    }
  }
}
