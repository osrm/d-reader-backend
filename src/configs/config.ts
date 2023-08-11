import { Config } from './config.interface';

const config: Config = {
  nest: {
    port: 3005,
    api: process.env.API_URL,
  },
  cors: {
    enabled: true,
  },
  swagger: {
    enabled: true,
    title: 'dReader API',
    description: 'API endpoints for dReader.io app',
    version: '0.9.8',
    path: 'api',
    persistAuthorization: true,
  },
  security: {
    expiresIn: '7d',
    refreshIn: '30d',
    bcryptSaltOrRound: 10,
  },
  s3: {
    region: process.env.AWS_BUCKET_REGION,
    bucket: process.env.AWS_BUCKET_NAME,
    cdn: process.env.CDN_URL,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  },
  throttle: {
    ttl: 30,
    limit: 120,
    ignoreUserAgents: [],
  },
};

export default (): Config => config;
