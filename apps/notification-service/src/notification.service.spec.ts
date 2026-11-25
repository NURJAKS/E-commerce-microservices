import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTING_KEYS } from '@shop/rmq';
import { InvoicePdfService } from './invoice-pdf.service';
import { NotificationService } from './notification.service';

describe('NotificationService — Batched Back-in-Stock Alerts & Async PDF Invoices', () => {
  let notificationService: NotificationService;
  let mockRmqService: any;
  let mockGateway: any;
  let mockInvoicePdf: any;
  let mockSendMail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRmqService = {
      subscribe: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(true),
    };
    mockGateway = {
      emitOrderStatusUpdated: vi.fn(),
      emitProductRestocked: vi.fn(),
    };
    mockInvoicePdf = {
      generateAndStoreInvoice: vi.fn().mockResolvedValue({
        key: 'invoices/invoice-ord-pdf-1.pdf',
        fileName: 'invoice-ord-pdf-.pdf',
        pdfBuffer: Buffer.from('%PDF-1.3 mock invoice'),
      }),
    };

    notificationService = new NotificationService(
      mockRmqService,
      mockGateway,
      mockInvoicePdf,
    );
    mockSendMail = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
    (notificationService as any).transporter = { sendMail: mockSendMail };
  });

  it('fans out Back-in-Stock emails in batches and pushes WebSocket alerts to authenticated subscribers', async () => {
    const subscribers = Array.from({ length: 15 }, (_, idx) => ({
      userId: idx < 10 ? `user-${idx}` : null,
      email: `sub-${idx}@shop.local`,
    }));

    await notificationService.handleProductRestocked({
      productId: 'prod-restock-1',
      productTitle: 'Keychron Pro Keyboard',
      price: 189,
      stock: 5,
      subscribers,
      restockedAt: new Date().toISOString(),
    });

    expect(mockSendMail).toHaveBeenCalledTimes(15);
    expect(mockGateway.emitProductRestocked).toHaveBeenCalledTimes(10);
    expect(mockGateway.emitProductRestocked).toHaveBeenCalledWith(
      'user-0',
      expect.objectContaining({
        productId: 'prod-restock-1',
        stock: 5,
      }),
    );
  });

  it('renders a valid PDF receipt via PDFKit, attaches it to Mailpit email, and emits order.invoice.generated', async () => {
    const pdfService = new InvoicePdfService();
    const realPdf = await pdfService.renderInvoicePdf({
      paymentId: 'pay-1',
      orderId: 'ord-pdf-12345678',
      userId: 'user-1',
      userEmail: 'buyer@shop.local',
      items: [
        {
          productId: 'p-1',
          productTitle: 'Mechanical Keyboard',
          quantity: 1,
          unitPrice: 189,
        },
      ],
      amount: 189,
      transactionId: 'tx_pdf_001',
      paidAt: new Date().toISOString(),
    });
    expect(realPdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(realPdf.length).toBeGreaterThan(500);

    await notificationService.handlePaymentSucceeded(
      {
        paymentId: 'pay-1',
        orderId: 'ord-pdf-1',
        userId: 'user-1',
        userEmail: 'buyer@shop.local',
        amount: 189,
        transactionId: 'tx_pdf_001',
        paidAt: new Date().toISOString(),
      },
      'trace-pdf',
    );

    expect(mockInvoicePdf.generateAndStoreInvoice).toHaveBeenCalledTimes(1);
    expect(mockRmqService.publish).toHaveBeenCalledWith(
      ROUTING_KEYS.INVOICE_GENERATED,
      expect.objectContaining({
        orderId: 'ord-pdf-1',
        invoiceKey: 'invoices/invoice-ord-pdf-1.pdf',
      }),
      'trace-pdf',
    );
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'buyer@shop.local',
        attachments: [
          expect.objectContaining({
            contentType: 'application/pdf',
          }),
        ],
      }),
    );
  });
});
