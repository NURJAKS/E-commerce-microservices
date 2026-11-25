import { Injectable, Logger } from '@nestjs/common';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import PDFDocument from 'pdfkit';
import { PaymentSucceededEvent } from '@shop/contracts';

@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;

  constructor() {
    const endpoint = process.env.MINIO_ENDPOINT || 'http://localhost:9000';
    this.bucket = process.env.MINIO_INVOICE_BUCKET || 'invoices-private';

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

  /**
   * Renders a PDF receipt asynchronously in memory using PDFKit.
   */
  async renderInvoicePdf(event: PaymentSucceededEvent): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const invoiceNumber = `INV-${event.orderId.slice(0, 8).toUpperCase()}`;
      const paidDate = new Date(event.paidAt || Date.now()).toUTCString();

      doc
        .fontSize(22)
        .fillColor('#1e293b')
        .text('NOVASHOP', { align: 'left' })
        .fontSize(10)
        .fillColor('#64748b')
        .text('Official Payment Receipt / Tax Invoice', { align: 'left' });

      doc.moveDown(1.2);
      doc
        .fontSize(11)
        .fillColor('#0f172a')
        .text(`Invoice Number: ${invoiceNumber}`)
        .text(`Order ID: ${event.orderId}`)
        .text(`Transaction ID: ${event.transactionId}`)
        .text(`Customer: ${event.userEmail || event.userId}`)
        .text(`Paid At: ${paidDate}`);

      doc.moveDown(1);
      doc
        .moveTo(50, doc.y)
        .lineTo(545, doc.y)
        .strokeColor('#cbd5e1')
        .stroke();
      doc.moveDown(0.8);

      doc.fontSize(12).fillColor('#0f172a').text('Order Line Items');
      doc.moveDown(0.5);

      const items = event.items || [];
      if (items.length === 0) {
        doc
          .fontSize(10)
          .fillColor('#475569')
          .text(`Order #${event.orderId.slice(0, 8)} — $${event.amount.toFixed(2)}`);
      } else {
        for (const item of items) {
          const lineTotal = (Number(item.unitPrice) * item.quantity).toFixed(2);
          doc
            .fontSize(10)
            .fillColor('#1e293b')
            .text(
              `${item.productTitle}  (x${item.quantity} @ $${Number(item.unitPrice).toFixed(2)})`,
              { continued: true },
            )
            .fillColor('#0f172a')
            .text(`$${lineTotal}`, { align: 'right' });
        }
      }

      doc.moveDown(1);
      doc
        .moveTo(50, doc.y)
        .lineTo(545, doc.y)
        .strokeColor('#cbd5e1')
        .stroke();
      doc.moveDown(0.8);

      doc
        .fontSize(14)
        .fillColor('#059669')
        .text(`Total Paid: $${Number(event.amount).toFixed(2)} USD`, {
          align: 'right',
        });

      doc.moveDown(2);
      doc
        .fontSize(9)
        .fillColor('#94a3b8')
        .text(
          'Stored securely in private MinIO storage. Access requires an authenticated, short-lived Presigned URL.',
          { align: 'center' },
        );

      doc.end();
    });
  }

  /**
   * Generates the PDF invoice and uploads it into the PRIVATE MinIO bucket (no public-read policy).
   */
  async generateAndStoreInvoice(
    event: PaymentSucceededEvent,
  ): Promise<{ key: string; fileName: string; pdfBuffer: Buffer }> {
    const pdfBuffer = await this.renderInvoicePdf(event);
    const shortId = event.orderId.slice(0, 8);
    const fileName = `invoice-${shortId}.pdf`;
    const key = `invoices/invoice-${event.orderId}.pdf`;

    try {
      await this.ensurePrivateBucketExists();
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
          Metadata: {
            orderId: event.orderId,
            userId: event.userId,
          },
        }),
      );
      this.logger.log(
        `[Invoice] Stored private PDF "${key}" (${pdfBuffer.length} bytes) in private MinIO bucket "${this.bucket}"`,
      );
    } catch (err: any) {
      this.logger.warn(
        `[Invoice] MinIO upload warning for "${key}": ${err?.message || err}`,
      );
    }

    return { key, fileName, pdfBuffer };
  }

  private async ensurePrivateBucketExists(): Promise<void> {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      // Intentionally NO PutBucketPolicy public-read rule — invoices bucket remains strictly PRIVATE
      await this.s3Client.send(
        new CreateBucketCommand({ Bucket: this.bucket }),
      );
      this.logger.log(
        `Created PRIVATE MinIO bucket "${this.bucket}" (no public access)`,
      );
    }
  }
}
