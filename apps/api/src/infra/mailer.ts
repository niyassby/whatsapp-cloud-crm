import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { ApiEnv } from '../env';

export { MAILER } from './infra.tokens';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Outbound email. Local dev: SMTP to Mailpit (http://localhost:8025). */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  private readonly logger = new Logger('Mailer');

  constructor(private readonly env: ApiEnv) {
    this.transport = createTransport(env.SMTP_URL);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.env.MAIL_FROM, ...message });
    // Never log message bodies: they contain one-time links.
    this.logger.log(`sent "${message.subject}"`);
  }
}

/** Test double: captures messages in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  /** Most recent message to `to`. */
  lastTo(to: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}
