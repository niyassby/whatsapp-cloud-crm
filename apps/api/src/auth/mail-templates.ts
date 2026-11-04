import type { MailMessage } from '../infra/mailer';

// TODO(branding): per-partner sender name, logo and colours plug in here (Section 4+).

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function layout(
  appName: string,
  heading: string,
  body: string,
  cta: { label: string; url: string },
) {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#f5f5f5;padding:24px">
<div style="max-width:480px;margin:auto;background:#fff;border-radius:8px;padding:32px">
<h2 style="margin-top:0">${escape(heading)}</h2>
<p style="color:#444;line-height:1.5">${body}</p>
<p><a href="${escape(cta.url)}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escape(cta.label)}</a></p>
<p style="color:#888;font-size:12px">If the button does not work, open this link:<br>${escape(cta.url)}</p>
<p style="color:#888;font-size:12px">${escape(appName)}</p>
</div></body></html>`;
}

export function verifyEmailMail(appName: string, to: string, url: string): MailMessage {
  return {
    to,
    subject: `Verify your email for ${appName}`,
    text: `Confirm your email address:\n\n${url}\n\nThe link expires in 24 hours.`,
    html: layout(
      appName,
      'Confirm your email',
      'Confirm your email address to finish setting up your account. The link expires in 24 hours.',
      { label: 'Verify email', url },
    ),
  };
}

export function resetPasswordMail(appName: string, to: string, url: string): MailMessage {
  return {
    to,
    subject: `Reset your ${appName} password`,
    text: `Reset your password:\n\n${url}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email.`,
    html: layout(
      appName,
      'Reset your password',
      'Use the button below to choose a new password. The link expires in 1 hour. If you did not ask for this, you can ignore this email.',
      { label: 'Reset password', url },
    ),
  };
}

export function inviteMail(
  appName: string,
  to: string,
  url: string,
  orgName: string,
  inviterName: string,
): MailMessage {
  return {
    to,
    subject: `${inviterName} invited you to ${orgName} on ${appName}`,
    text: `${inviterName} invited you to join ${orgName}.\n\nAccept the invitation:\n${url}\n\nThe link expires in 7 days.`,
    html: layout(
      appName,
      `Join ${orgName}`,
      `${escape(inviterName)} invited you to join <strong>${escape(orgName)}</strong>. The link expires in 7 days.`,
      { label: 'Accept invitation', url },
    ),
  };
}
