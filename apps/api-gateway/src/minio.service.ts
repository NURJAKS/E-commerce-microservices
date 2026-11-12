import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import * as crypto from 'crypto';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor() {
    const endpoint = process.env.MINIO_ENDPOINT || 'http://localhost:9000';
    this.publicUrl = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000';
    this.bucket = process.env.MINIO_BUCKET || 'products-media';

    this.s3Client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
        secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
      },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureBucketExists();
    } catch (err: any) {
      this.logger.warn(
        `Deferred MinIO bucket check until first upload: ${err?.message || err}`,
      );
    }
  }

  async uploadProductImage(file: {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  }): Promise<{ url: string; key: string }> {
    if (!file) {
      throw new BadRequestException('No image file provided');
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported MIME type "${file.mimetype}". Allowed: jpeg, png, webp, gif`,
      );
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException('File size exceeds 10 MB limit');
    }

    await this.ensureBucketExists();

    const ext = file.originalname.split('.').pop() || 'jpg';
    const key = `product-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    const url = `${this.publicUrl.replace(/\/$/, '')}/${this.bucket}/${key}`;
    this.logger.log(`Uploaded image "${key}" to MinIO bucket "${this.bucket}"`);

    return { url, key };
  }

  private async ensureBucketExists(): Promise<void> {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.s3Client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
        const publicPolicy = {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${this.bucket}/*`],
            },
          ],
        };
        await this.s3Client.send(
          new PutBucketPolicyCommand({
            Bucket: this.bucket,
            Policy: JSON.stringify(publicPolicy),
          }),
        );
        this.logger.log(
          `Created MinIO bucket "${this.bucket}" with public-read policy`,
        );
      } catch (err: any) {
        this.logger.warn(
          `Bucket creation warning for "${this.bucket}": ${err?.message || err}`,
        );
      }
    }
  }
}
