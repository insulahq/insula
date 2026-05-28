import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
const createTransport = vi.fn().mockReturnValue({ sendMail: sendMailMock });

vi.mock('nodemailer', () => ({
  default: { createTransport },
  createTransport,
}));

const decryptMock = vi.fn().mockReturnValue('decrypted-password');
vi.mock('../../oidc/crypto.js', () => ({ decrypt: decryptMock }));

const { sendViaStalwartMaster } = await import('./email-stalwart-master.js');

beforeEach(() => {
  sendMailMock.mockClear();
  createTransport.mockClear();
  decryptMock.mockClear();
  decryptMock.mockReturnValue('decrypted-password');
});

describe('sendViaStalwartMaster', () => {
  it('builds a nodemailer transport from the relay row and sends', async () => {
    const r = await sendViaStalwartMaster(
      {
        smtpHost: 'stalwart-submission.mail.svc.cluster.local',
        smtpPort: 587,
        authUsername: 'master@example.com',
        authPasswordEncrypted: 'iv:tag:cipher',
        fromAddress: 'notifications@example.com',
      },
      {
        to: 'user@x.com',
        subject: 'Hi',
        html: '<p>Hello</p>',
      },
      'KEY',
    );

    expect(r.providerMessageId).toBe('msg-1');
    expect(decryptMock).toHaveBeenCalledWith('iv:tag:cipher', 'KEY');
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'stalwart-submission.mail.svc.cluster.local',
      port: 587,
      secure: false,
    }));
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Hosting Platform <notifications@example.com>',
      to: 'user@x.com',
    }));
  });

  it('falls back to authUsername in From when fromAddress is unset', async () => {
    await sendViaStalwartMaster(
      {
        smtpHost: 'h',
        smtpPort: 465,
        authUsername: 'master@x.com',
        authPasswordEncrypted: 'iv:tag:c',
        fromAddress: null,
      },
      { to: 't@x.com', subject: 'S', html: '<p>B</p>' },
      'K',
    );
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Hosting Platform <master@x.com>',
    }));
  });

  it('uses TLS on port 465', async () => {
    await sendViaStalwartMaster(
      {
        smtpHost: 'h',
        smtpPort: 465,
        authUsername: 'master@x.com',
        authPasswordEncrypted: 'iv:tag:c',
        fromAddress: 'n@x.com',
      },
      { to: 't@x.com', subject: 'S', html: '<p>B</p>' },
      'K',
    );
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
  });

  it('throws when smtpHost is missing', async () => {
    await expect(sendViaStalwartMaster(
      { smtpHost: null, smtpPort: 587, authUsername: 'u', authPasswordEncrypted: 'e', fromAddress: null },
      { to: 't', subject: 's', html: 'h' },
      'K',
    )).rejects.toThrow(/smtpHost/);
  });

  it('throws when authUsername is missing', async () => {
    await expect(sendViaStalwartMaster(
      { smtpHost: 'h', smtpPort: 587, authUsername: null, authPasswordEncrypted: 'e', fromAddress: null },
      { to: 't', subject: 's', html: 'h' },
      'K',
    )).rejects.toThrow(/authUsername/);
  });

  it('throws when password is missing', async () => {
    await expect(sendViaStalwartMaster(
      { smtpHost: 'h', smtpPort: 587, authUsername: 'u', authPasswordEncrypted: null, fromAddress: null },
      { to: 't', subject: 's', html: 'h' },
      'K',
    )).rejects.toThrow(/authPasswordEncrypted/);
  });
});
