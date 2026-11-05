/**
 * Launches Meta Embedded Signup. The popup reports through two separate channels, in no fixed
 * order: FB.login's callback carries the `code`, and a postMessage carries the WABA and number
 * ids. The result resolves once both have arrived.
 */

export interface SignupResult {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  metaUserId?: string;
}

export class SignupCancelledError extends Error {
  constructor(message = 'Signup was cancelled') {
    super(message);
    this.name = 'SignupCancelledError';
  }
}

interface FbLoginResponse {
  authResponse?: { code?: string; userID?: string } | null;
}

interface FacebookSdk {
  init(options: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(callback: (response: FbLoginResponse) => void, options: Record<string, unknown>): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

export type SignupMessage =
  | { kind: 'finish'; wabaId: string; phoneNumberId: string }
  | { kind: 'cancel'; step?: string }
  | { kind: 'error'; message: string };

/**
 * Interpret a window `message` event. Only facebook.com origins count: any page could post a
 * lookalike message, and these ids decide which WABA we try to connect.
 */
export function parseSignupMessage(origin: string, data: unknown): SignupMessage | null {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return null;
  if (typeof data !== 'string') return null;

  let parsed: { type?: string; event?: string; data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (parsed.type !== 'WA_EMBEDDED_SIGNUP') return null;

  const d = parsed.data ?? {};
  if (parsed.event === 'CANCEL') {
    return {
      kind: 'cancel',
      step: typeof d.current_step === 'string' ? d.current_step : undefined,
    };
  }
  if (parsed.event === 'ERROR') {
    const message = typeof d.error_message === 'string' ? d.error_message : 'Signup failed';
    return { kind: 'error', message };
  }
  if (parsed.event === 'FINISH') {
    if (typeof d.waba_id === 'string' && typeof d.phone_number_id === 'string') {
      return { kind: 'finish', wabaId: d.waba_id, phoneNumberId: d.phone_number_id };
    }
    return { kind: 'error', message: 'Signup finished without choosing a phone number' };
  }
  if (parsed.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
    // Meta says to skip registration for these numbers, and connecting always registers.
    return {
      kind: 'error',
      message: 'Numbers that stay on the WhatsApp Business app are not supported yet',
    };
  }
  if (typeof parsed.event === 'string' && parsed.event.startsWith('FINISH')) {
    return { kind: 'error', message: 'Signup finished without choosing a phone number' };
  }
  return null;
}

let sdkPromise: Promise<FacebookSdk> | null = null;

function loadSdk(appId: string, version: string): Promise<FacebookSdk> {
  sdkPromise ??= new Promise<FacebookSdk>((resolve, reject) => {
    const ready = () => {
      const fb = window.FB;
      if (!fb) return reject(new Error('Facebook SDK did not initialise'));
      fb.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(fb);
    };
    window.fbAsyncInit = ready;
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error('Could not load the Facebook SDK. Check ad blockers and your connection.'));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/**
 * How long to wait for the account ids once the code has arrived. The code expires after 30
 * seconds and the API still has to exchange it, so waiting any longer cannot succeed.
 */
const IDS_AFTER_CODE_TIMEOUT_MS = 15_000;

export async function launchEmbeddedSignup(config: {
  appId: string;
  configId: string;
  graphApiVersion: string;
}): Promise<SignupResult> {
  const fb = await loadSdk(config.appId, config.graphApiVersion);

  return new Promise<SignupResult>((resolve, reject) => {
    let ids: { wabaId: string; phoneNumberId: string } | null = null;
    let auth: { code: string; metaUserId?: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      if (timer) clearTimeout(timer);
    };
    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const maybeFinish = () => {
      if (ids && auth) {
        cleanup();
        resolve({ ...ids, ...auth });
      }
    };

    function onMessage(event: MessageEvent) {
      const msg = parseSignupMessage(event.origin, event.data);
      if (!msg) return;
      if (msg.kind === 'cancel') return fail(new SignupCancelledError());
      if (msg.kind === 'error') return fail(new Error(msg.message));
      // No timer here: the ids can arrive while the customer is still on the final screen, and
      // the FB.login callback always fires when the popup closes.
      ids = { wabaId: msg.wabaId, phoneNumberId: msg.phoneNumberId };
      maybeFinish();
    }
    window.addEventListener('message', onMessage);

    // FB.login rejects async callbacks, so this stays synchronous.
    fb.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          // Closing the final screen with X reports the ids, but only Finish returns a code.
          return fail(
            ids
              ? new Error('Facebook did not finish the connection. Run it again and click Finish.')
              : new SignupCancelledError(),
          );
        }
        auth = { code, metaUserId: response.authResponse?.userID ?? undefined };
        if (!ids) {
          timer = setTimeout(
            () => fail(new Error('Facebook did not return the account details. Please try again.')),
            IDS_AFTER_CODE_TIMEOUT_MS,
          );
        }
        maybeFinish();
      },
      {
        config_id: config.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} },
      },
    );
  });
}
