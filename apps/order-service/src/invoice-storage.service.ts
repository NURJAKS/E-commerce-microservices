import { Injectable, Logger } from '@nestjs/common';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import PDFDocument from 'pdfkit';
import { InvoiceDownloadResponse } from '@shop/contracts';

export const INVOICE_PRESIGN_TTL_SECONDS = 60;

@Injectable()
export class InvoiceStorageService {
  private readonly logger = new Logger(InvoiceStorageService.name);
  private readonly s3Client: S3Client;
  private readonly presignClient: S3Client;
  private readonly bucket: string;

  constructor() {
    const endpoint = process.env.MINIO_ENDPOINT || 'http://localhost:9000';
    const publicUrl = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000';
    this.bucket = process.env.MINIO_INVOICE_BUCKET || 'invoices-private';

    const credentials = {
      accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
      secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    };

    this.s3Client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials,
    });

    // Public-endpoint client ensures SigV4 Host header matches browser direct downloads
    this.presignClient = new S3Client({
      endpoint: publicUrl,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials,
    });
  }

  /**
   * Generates a 60-second Presigned GET URL for a private PDF invoice stored in MinIO.
   */
  async createPresignedDownloadUrl(
    invoiceKey: string,
    orderId: string,
  ): Promise<InvoiceDownloadResponse> {
    const fileName = `invoice-${orderId.slice(0, 8)}.pdf`;

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: invoiceKey,
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: `attachment; filename="${fileName}"`,
    });

    const downloadUrl = await getSignedUrl(this.presignClient, command, {
      expiresIn: INVOICE_PRESIGN_TTL_SECONDS,
    });

    return {
      downloadUrl,
      fileName,
      expiresInSeconds: INVOICE_PRESIGN_TTL_SECONDS,
    };
  }

  /**
   * Fallback generator if a user downloads an invoice for an order paid before async PDF storage finished.
   */
  async ensureFallbackInvoice(order: {
    id: string;
    userId: string;
    totalAmount: any;
    createdAt: Date;
    items: Array<{
      productTitle: string;
      quantity: number;
      unitPrice: any;
    }>;
  }): Promise<string> {
    const key = `invoices/invoice-${order.id}.pdf`;
    const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text('NOVASHOP — PAYMENT RECEIPT');
      doc.moveDown(0.5);
      doc.fontSize(11).text(`Order ID: ${order.id}`);
      doc.text(`Date: ${order.createdAt.toUTCString()}`);
      doc.moveDown(1);
      for (const item of order.items || []) {
        doc.text(
          `${item.productTitle} x${item.quantity} — $${(Number(item.unitPrice) * item.quantity).toFixed(2)}`,
        );
      }
      doc.moveDown(1);
      doc.fontSize(13).text(`Total Paid: $${Number(order.totalAmount).toFixed(2)} USD`);
      doc.end();
    });

    try {
      try {
        await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        await this.s3Client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
      }

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
        }),
      );
    } catch (err: any) {
      this.logger.warn(
        `[Invoice] Fallback upload warning for ${key}: ${err?.message || err}`,
      );
    }

    return key;
  }
}
