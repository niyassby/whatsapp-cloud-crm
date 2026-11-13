'use client';

import type { CallDto } from '@wacrm/shared';
import { create } from 'zustand';
import { api } from './api';

/**
 * WhatsApp calls in the browser. Meta only carries signalling: the agent's browser makes the
 * WebRTC offer or answer, and audio flows between it and Meta. Not yet tried against Meta.
 */

interface ActiveCall {
  call: CallDto;
  pc: RTCPeerConnection;
  mic: MediaStream;
}

interface CallState {
  /** A customer is calling, with Meta's SDP offer. */
  ringing: { call: CallDto; offer: string } | null;
  active: ActiveCall | null;
  error: string | null;
  onUpdate: (e: { call: CallDto; offer?: string; answer?: string }) => void;
}

const FINAL = new Set(['ended', 'missed', 'rejected', 'failed']);
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

function hangUpLocal(active: ActiveCall | null) {
  if (!active) return;
  active.pc.close();
  for (const t of active.mic.getTracks()) t.stop();
}

export const useCalls = create<CallState>((set, get) => ({
  ringing: null,
  active: null,
  error: null,
  onUpdate: ({ call, offer, answer }) => {
    const { ringing, active } = get();
    if (offer && call.status === 'ringing' && call.direction === 'inbound') {
      set({ ringing: { call, offer } });
      return;
    }
    if (ringing?.call.id === call.id && call.status !== 'ringing') set({ ringing: null });
    if (active?.call.id === call.id) {
      if (answer && active.pc.signalingState === 'have-local-offer') {
        void active.pc.setRemoteDescription({ type: 'answer', sdp: answer });
      }
      if (FINAL.has(call.status)) {
        hangUpLocal(active);
        set({ active: null });
      } else {
        set({ active: { ...active, call } });
      }
    }
  },
}));

/** The local description once ICE gathering is done (or after 3 seconds), since Meta takes no trickle. */
async function gatheredSdp(pc: RTCPeerConnection): Promise<string> {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const done = () => {
        if (pc.iceGatheringState === 'complete') resolve();
      };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 3000);
    });
  }
  return pc.localDescription?.sdp ?? '';
}

async function connection(): Promise<{ pc: RTCPeerConnection; mic: MediaStream }> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const pc = new RTCPeerConnection({ iceServers: ICE });
  for (const track of mic.getTracks()) pc.addTrack(track, mic);
  pc.addEventListener('track', (e) => {
    const audio = document.getElementById('call-audio') as HTMLAudioElement | null;
    if (audio && e.streams[0]) {
      audio.srcObject = e.streams[0];
      void audio.play().catch(() => undefined);
    }
  });
  return { pc, mic };
}

export async function answerCall(): Promise<void> {
  const ringing = useCalls.getState().ringing;
  if (!ringing) return;
  const { pc, mic } = await connection();
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: ringing.offer });
    await pc.setLocalDescription(await pc.createAnswer());
    const call = await api<CallDto>(`/calls/${ringing.call.id}/accept`, {
      method: 'POST',
      body: { sdp: await gatheredSdp(pc) },
    });
    useCalls.setState({ ringing: null, active: { call, pc, mic }, error: null });
  } catch (err) {
    hangUpLocal({ call: ringing.call, pc, mic });
    useCalls.setState({ error: err instanceof Error ? err.message : 'Could not answer' });
    throw err;
  }
}

export async function declineCall(): Promise<void> {
  const ringing = useCalls.getState().ringing;
  if (!ringing) return;
  useCalls.setState({ ringing: null });
  await api(`/calls/${ringing.call.id}/reject`, { method: 'POST' });
}

export async function startCall(conversationId: string): Promise<void> {
  const { pc, mic } = await connection();
  try {
    await pc.setLocalDescription(await pc.createOffer({ offerToReceiveAudio: true }));
    const call = await api<CallDto>(`/inbox/conversations/${conversationId}/calls`, {
      method: 'POST',
      body: { sdp: await gatheredSdp(pc) },
    });
    useCalls.setState({ active: { call, pc, mic }, error: null });
  } catch (err) {
    pc.close();
    for (const t of mic.getTracks()) t.stop();
    throw err;
  }
}

export async function hangUp(): Promise<void> {
  const active = useCalls.getState().active;
  if (!active) return;
  useCalls.setState({ active: null });
  hangUpLocal(active);
  await api(`/calls/${active.call.id}/terminate`, { method: 'POST' }).catch(() => undefined);
}
