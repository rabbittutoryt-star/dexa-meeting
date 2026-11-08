'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  user: null,
  accounts: [],
  addingAccount: false,
  profileAvatarData: null,
  removeProfileAvatar: false,
  roomId: null,
  clientId: null,
  pollGeneration: 0,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  rawStream: null,
  screenStream: null,
  cameraOutputTrack: null,
  canvasStream: null,
  peers: new Map(),
  participants: new Map(),
  micEnabled: true,
  cameraEnabled: true,
  sharing: false,
  meetingActive: false,
  joinedRoom: false,
  meetingStartedAt: 0,
  timerHandle: null,
  backgroundMode: 'none',
  backgroundImage: null,
  backgroundLoopId: 0,
  backgroundFrameHandle: 0,
  backgroundFrameApi: null,
  seenMessageIds: new Set(),
};

const views = {
  auth: $('#authView'),
  lobby: $('#lobbyView'),
  meeting: $('#meetingView'),
};

function showView(name) {
  Object.entries(views).forEach(([key, element]) => element.classList.toggle('hidden', key !== name));
}

function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('#toastRegion').append(element);
  window.setTimeout(() => element.remove(), 3600);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || 'Something went wrong.');
  return data;
}

function usernameToEmail(username) {
  return `${String(username || '').trim().toLowerCase()}@dexa.online`;
}

function setAuthTab(mode) {
  const login = mode === 'login';
  $('#loginTab').classList.toggle('active', login);
  $('#registerTab').classList.toggle('active', !login);
  $('#loginTab').setAttribute('aria-selected', String(login));
  $('#registerTab').setAttribute('aria-selected', String(!login));
  $('#loginForm').classList.toggle('hidden', !login);
  $('#registerForm').classList.toggle('hidden', login);
  $('#loginError').textContent = '';
  $('#registerError').textContent = '';
}

function showLobby() {
  showView('lobby');
  state.addingAccount = false;
  $('#cancelAddAccountButton').classList.add('hidden');
  renderProfileBars();
  renderAccountList();
  closeProfileMenu();
  $('#meetingCode').value = '';
  $('#lobbyError').textContent = '';
}

function normalizeRoomId(value) {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  if (clean.length !== 10) return null;
  return `${clean.slice(0, 3)}-${clean.slice(3, 7)}-${clean.slice(7, 10)}`;
}

function formatRoomInput(value) {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  const parts = [clean.slice(0, 3), clean.slice(3, 7), clean.slice(7, 10)].filter(Boolean);
  return parts.join('-');
}

async function requestMediaPermission() {
  const dialog = $('#permissionDialog');
  if (!dialog.showModal) return true;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue !== 'cancel'), { once: true });
  });
}

async function ensureLocalMedia() {
  if (state.rawStream) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone are not supported in this browser.');

  const allowed = await requestMediaPermission();
  if (!allowed) throw new Error('Camera and microphone permission is required to join.');

  try {
    state.rawStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    const secureHint = window.isSecureContext ? '' : ' Open the app through HTTPS or localhost.';
    throw new Error(`Camera or microphone permission was not granted.${secureHint}`);
  }

  $('#rawLocalVideo').srcObject = state.rawStream;
  await $('#rawLocalVideo').play().catch(() => {});
  state.cameraOutputTrack = state.rawStream.getVideoTracks()[0] || null;
  state.cameraEnabled = Boolean(state.cameraOutputTrack);
  state.micEnabled = Boolean(state.rawStream.getAudioTracks()[0]);
}

function getOutgoingStream(videoTrack = state.sharing ? state.screenStream?.getVideoTracks()[0] : state.cameraOutputTrack) {
  const tracks = [];
  if (videoTrack) tracks.push(videoTrack);
  const audioTrack = state.rawStream?.getAudioTracks()[0];
  if (audioTrack) tracks.push(audioTrack);
  return new MediaStream(tracks);
}

function initials(name) {
  return String(name || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function renderUserAvatar(image, fallback, user) {
  const avatar = String(user?.avatar || '');
  fallback.textContent = initials(user?.name || '?');
  if (avatar) {
    image.src = avatar;
    image.alt = `${user.name} profile picture`;
    image.classList.remove('hidden');
    fallback.classList.add('hidden');
  } else {
    image.removeAttribute('src');
    image.classList.add('hidden');
    fallback.classList.remove('hidden');
  }
}

function renderProfileBars() {
  if (!state.user) return;
  $('#accountName').textContent = state.user.name;
  $('#accountEmail').textContent = state.user.email;
  $('#dropdownName').textContent = state.user.name;
  $('#dropdownEmail').textContent = state.user.email;
  $('#sideAccountName').textContent = state.user.name;
  $('#sideAccountEmail').textContent = state.user.email;
  renderUserAvatar($('#accountAvatar'), $('#accountAvatarFallback'), state.user);
  renderUserAvatar($('#dropdownAvatar'), $('#dropdownAvatarFallback'), state.user);
  renderUserAvatar($('#sideAccountAvatar'), $('#sideAccountAvatarFallback'), state.user);
}

function openProfileMenu() {
  $('#profileDropdown').classList.remove('hidden');
  $('#profileMenuButton').setAttribute('aria-expanded', 'true');
}

function closeProfileMenu() {
  $('#profileDropdown').classList.add('hidden');
  $('#profileMenuButton').setAttribute('aria-expanded', 'false');
}

function renderAccountList() {
  const list = $('#accountList');
  list.replaceChildren();
  const accounts = state.accounts.length ? state.accounts : [state.user];
  for (const account of accounts) {
    const button = document.createElement('button');
    button.className = `account-option${account.id === state.user.id ? ' active' : ''}`;
    button.type = 'button';
    button.dataset.userId = account.id;
    button.disabled = account.id === state.user.id;

    const avatarWrap = document.createElement('span');
    avatarWrap.className = 'mini-avatar-wrap';
    if (account.avatar) {
      const image = document.createElement('img');
      image.src = account.avatar;
      image.alt = '';
      image.className = 'mini-avatar';
      avatarWrap.append(image);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'mini-avatar mini-avatar-fallback';
      fallback.textContent = initials(account.name);
      avatarWrap.append(fallback);
    }

    const copy = document.createElement('span');
    copy.className = 'account-option-copy';
    const name = document.createElement('strong');
    name.textContent = account.name;
    const email = document.createElement('small');
    email.textContent = account.email;
    copy.append(name, email);

    const check = document.createElement('span');
    check.className = 'account-check';
    check.textContent = account.id === state.user.id ? '✓' : '';
    button.append(avatarWrap, copy, check);
    list.append(button);
  }
  $('#logoutAllButton').classList.toggle('hidden', accounts.length < 2);
}

async function switchAccount(userId) {
  const data = await api('/api/accounts/switch', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  state.user = data.user;
  state.accounts = data.accounts || [];
  showLobby();
  toast(`Switched to ${state.user.name}.`);
}

function beginAddAccount() {
  state.addingAccount = true;
  closeProfileMenu();
  setAuthTab('login');
  $('#loginForm').reset();
  $('#registerForm').reset();
  $('#cancelAddAccountButton').classList.remove('hidden');
  showView('auth');
}

function openProfileEditor() {
  closeProfileMenu();
  state.profileAvatarData = null;
  state.removeProfileAvatar = false;
  $('#profileNameInput').value = state.user.name;
  $('#profileEmailInput').value = state.user.email;
  $('#profileAvatarInput').value = '';
  $('#profileError').textContent = '';
  renderUserAvatar($('#profileAvatarPreview'), $('#profileAvatarFallback'), state.user);
  $('#removeProfileAvatarButton').classList.toggle('hidden', !state.user.avatar);
  $('#profileDialog').showModal();
}

function imageFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('Choose a valid image file.'));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('Choose an image smaller than 8 MB.'));
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
        const sourceX = (image.naturalWidth - sourceSize) / 2;
        const sourceY = (image.naturalHeight - sourceSize) / 2;
        context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      } catch {
        reject(new Error('The selected image could not be processed.'));
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The selected image could not be opened.'));
    };
    image.src = url;
  });
}

function createVideoTile(id, user, local = false) {
  const tile = document.createElement('article');
  tile.className = `video-tile${local ? ' local' : ''}`;
  tile.dataset.peerId = id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = local;

  const avatar = document.createElement('div');
  avatar.className = 'video-avatar';
  avatar.innerHTML = user.avatar
    ? `<div class="avatar-circle has-image"><img src="${escapeHtml(user.avatar)}" alt=""></div>`
    : `<div class="avatar-circle">${escapeHtml(initials(user.name))}</div>`;

  const label = document.createElement('div');
  label.className = 'video-name';
  label.innerHTML = `<span class="media-indicator"></span><span>${escapeHtml(user.name)}${local ? ' (You)' : ''}</span>`;

  tile.append(video, avatar, label);
  $('#videoGrid').append(tile);
  updateGridLayout();
  return { tile, video, avatar, indicator: label.querySelector('.media-indicator') };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function updateGridLayout() {
  const count = Math.max(1, $('#videoGrid').children.length);
  let cols = 1;
  let rows = 1;
  if (count === 2) { cols = 2; rows = 1; }
  else if (count <= 4) { cols = 2; rows = 2; }
  else if (count <= 6) { cols = 3; rows = 2; }
  else if (count <= 9) { cols = 3; rows = 3; }
  else { cols = 4; rows = 3; }
  $('#videoGrid').style.setProperty('--grid-cols', cols);
  $('#videoGrid').style.setProperty('--grid-rows', rows);
}

function attachStreamToTile(tileInfo, stream, media = {}) {
  tileInfo.video.srcObject = stream;
  tileInfo.video.play().catch(() => {});
  updateTileAppearance(tileInfo, media);
}

function updateTileAppearance(tileInfo, media) {
  const hasVideo = Boolean(tileInfo.video.srcObject?.getVideoTracks().length);
  const cameraVisible = hasVideo && (media.sharing === true || media.camera !== false);
  tileInfo.avatar.classList.toggle('hidden', cameraVisible);
  tileInfo.video.classList.toggle('hidden', !cameraVisible);
  tileInfo.indicator.textContent = media.mic === false ? '🔇' : '';
  tileInfo.tile.classList.toggle('screen-share', media.sharing === true);
}

function updateLocalPreview() {
  const local = state.participants.get('local');
  if (!local) return;
  const displayTrack = state.sharing ? state.screenStream?.getVideoTracks()[0] : state.cameraOutputTrack;
  attachStreamToTile(local.tileInfo, getOutgoingStream(displayTrack), {
    mic: state.micEnabled,
    camera: state.cameraEnabled,
    sharing: state.sharing,
  });
}

function refreshParticipantProfile(participant, user, local = false) {
  if (!participant?.tileInfo || !user) return;
  participant.user = user;
  participant.tileInfo.avatar.innerHTML = user.avatar
    ? `<div class="avatar-circle has-image"><img src="${escapeHtml(user.avatar)}" alt=""></div>`
    : `<div class="avatar-circle">${escapeHtml(initials(user.name))}</div>`;
  const label = participant.tileInfo.tile.querySelector('.video-name span:last-child');
  if (label) label.textContent = `${user.name}${local ? ' (You)' : ''}`;
}

function refreshLocalProfileInMeeting() {
  const local = state.participants.get('local');
  if (!local) return;
  refreshParticipantProfile(local, state.user, true);
  renderPeople();
  broadcastEvent('profile-update', { user: state.user }).catch((error) => console.warn('Profile update broadcast failed:', error));
}

function mediaState() {
  return { mic: state.micEnabled, camera: state.cameraEnabled, sharing: state.sharing };
}

function broadcastMediaState() {
  broadcastEvent('media-state', mediaState()).catch((error) => console.warn('Media state broadcast failed:', error));
  const local = state.participants.get('local');
  if (local) local.media = mediaState();
  updateLocalPreview();
  renderPeople();
}

function setConnectionBadge(text, connected = true) {
  const badge = $('#connectionBadge');
  badge.textContent = text;
  badge.style.color = connected ? '#7de45e' : '#ff9ca4';
  badge.style.borderColor = connected ? 'rgba(87,201,52,.3)' : 'rgba(240,75,87,.3)';
  badge.style.background = connected ? 'rgba(87,201,52,.14)' : 'rgba(240,75,87,.12)';
}

async function roomApi(action, body = {}, method = 'POST') {
  if (!state.roomId) throw new Error('No active meeting.');
  const payload = action === 'join' ? body : { ...body, clientId: state.clientId };
  return api(`/api/rooms/${encodeURIComponent(state.roomId)}/${action}`, {
    method,
    body: method === 'GET' ? undefined : JSON.stringify(payload),
  });
}

function sendSignal(target, type, payload) {
  if (!state.meetingActive || !state.clientId) return;
  roomApi('signal', { target, type, payload }).catch((error) => console.warn('Signal failed:', error));
}

function broadcastEvent(event, data) {
  if (!state.meetingActive || !state.clientId) return Promise.reject(new Error('You are not connected to the meeting.'));
  return roomApi('broadcast', { event, data });
}

async function handleRoomEvent(event) {
  const data = event.data || {};
  if (event.type === 'user-joined') {
    if (!state.meetingActive || state.peers.has(data.clientId)) return;
    addRemoteParticipant(data.clientId, data.user, data.media);
    createPeerConnection(data.clientId);
    toast(`${data.user.name} joined the meeting.`);
    return;
  }
  if (event.type === 'user-left') {
    removePeer(data.clientId);
    if (data.user?.name) toast(`${data.user.name} left the meeting.`);
    return;
  }
  if (event.type === 'webrtc-offer') {
    const { from, payload, user } = data;
    try {
      if (!state.peers.has(from)) addRemoteParticipant(from, user || { name: 'Participant', email: '' }, {});
      const peer = createPeerConnection(from);
      await peer.pc.setRemoteDescription(payload);
      await flushPendingCandidates(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      sendSignal(from, 'webrtc-answer', peer.pc.localDescription);
    } catch (error) {
      console.error('Offer handling failed:', error);
    }
    return;
  }
  if (event.type === 'webrtc-answer') {
    const peer = state.peers.get(data.from);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(data.payload);
      await flushPendingCandidates(peer);
    } catch (error) {
      console.error('Answer handling failed:', error);
    }
    return;
  }
  if (event.type === 'webrtc-ice-candidate') {
    const peer = state.peers.get(data.from);
    if (!peer) return;
    try {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.payload);
      else peer.pendingCandidates.push(data.payload);
    } catch (error) {
      console.warn('ICE candidate could not be added:', error);
    }
    return;
  }
  if (event.type === 'media-state') {
    const peer = state.peers.get(data.clientId);
    if (!peer) return;
    peer.media = data.media;
    updateTileAppearance(peer.tileInfo, data.media);
    renderPeople();
    return;
  }
  if (event.type === 'profile-update') {
    const peer = state.peers.get(data.clientId);
    if (!peer || !data.user) return;
    refreshParticipantProfile(peer, data.user, false);
    renderPeople();
    return;
  }
  if (event.type === 'chat-message') addChatMessage(data);
  if (event.type === 'reaction') showReaction(data.emoji);
}

function startEventLoop() {
  const generation = ++state.pollGeneration;
  const poll = async () => {
    while (state.meetingActive && state.clientId && generation === state.pollGeneration) {
      try {
        const result = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/events?clientId=${encodeURIComponent(state.clientId)}`, { method: 'GET' });
        setConnectionBadge('Connected', true);
        for (const event of result.events || []) await handleRoomEvent(event);
      } catch (error) {
        if (!state.meetingActive || generation !== state.pollGeneration) break;
        setConnectionBadge('Reconnecting', false);
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      }
    }
  };
  poll();
}

function addRemoteParticipant(socketId, user, media = {}) {
  if (state.peers.has(socketId)) return state.peers.get(socketId);
  const tileInfo = createVideoTile(socketId, user, false);
  const peer = { socketId, user, media, tileInfo, pc: null, pendingCandidates: [] };
  state.peers.set(socketId, peer);
  state.participants.set(socketId, peer);
  updateTileAppearance(tileInfo, media);
  renderPeople();
  return peer;
}

function createPeerConnection(socketId) {
  const peer = state.peers.get(socketId);
  if (!peer) throw new Error('Participant is missing.');
  if (peer.pc) return peer;

  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  peer.pc = pc;
  const outgoing = getOutgoingStream();
  outgoing.getTracks().forEach((track) => pc.addTrack(track, outgoing));

  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal(socketId, 'webrtc-ice-candidate', event.candidate);
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    attachStreamToTile(peer.tileInfo, stream, peer.media);
    event.track.addEventListener('mute', () => updateTileAppearance(peer.tileInfo, { ...peer.media, camera: false }));
    event.track.addEventListener('unmute', () => updateTileAppearance(peer.tileInfo, peer.media));
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) removePeer(socketId);
  };

  return peer;
}

async function makeOffer(socketId) {
  const peer = createPeerConnection(socketId);
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  sendSignal(socketId, 'webrtc-offer', peer.pc.localDescription);
}

async function flushPendingCandidates(peer) {
  const candidates = peer.pendingCandidates.splice(0);
  for (const candidate of candidates) await peer.pc.addIceCandidate(candidate);
}

function removePeer(socketId) {
  const peer = state.peers.get(socketId);
  if (!peer) return;
  try { peer.pc?.close(); } catch {}
  peer.tileInfo.tile.remove();
  state.peers.delete(socketId);
  state.participants.delete(socketId);
  updateGridLayout();
  renderPeople();
}

async function joinRoom(roomId) {
  await ensureLocalMedia();
  const config = await api('/api/config');
  state.iceServers = config.iceServers;
  state.roomId = roomId;
  state.seenMessageIds.clear();
  $('#chatMessages').innerHTML = '<div class="empty-panel"><strong>Meeting chat</strong><span>Messages are visible to everyone in this room.</span></div>';
  state.meetingActive = true;
  state.joinedRoom = false;
  state.meetingStartedAt = Date.now();
  renderProfileBars();
  showView('meeting');
  $('#roomCodeLabel').textContent = roomId;
  $('#videoGrid').replaceChildren();
  state.participants.clear();
  const localTileInfo = createVideoTile('local', state.user, true);
  state.participants.set('local', { user: state.user, media: mediaState(), tileInfo: localTileInfo });
  updateMicButton();
  $('#shareButton').classList.toggle('active', state.sharing);
  $('#shareButton').setAttribute('aria-pressed', String(state.sharing));
  $('#shareButton').setAttribute('aria-label', state.sharing ? 'Stop sharing screen' : 'Share screen');
  updateLocalPreview();
  renderPeople();
  startMeetingTimer();

  try {
    const result = await roomApi('join', { media: mediaState() });
    if (!result?.ok) throw new Error(result?.error || 'Could not join this meeting.');
    state.clientId = result.clientId;
    state.joinedRoom = true;
    startEventLoop();
    for (const existing of result.peers || []) {
      addRemoteParticipant(existing.clientId, existing.user, existing.media);
      await makeOffer(existing.clientId);
    }
    setConnectionBadge('Connected', true);
  } catch (error) {
    await leaveMeeting(false);
    throw error;
  }
}

function startMeetingTimer() {
  window.clearInterval(state.timerHandle);
  const update = () => {
    const seconds = Math.floor((Date.now() - state.meetingStartedAt) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    $('#meetingTime').textContent = hours > 0
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
  };
  update();
  state.timerHandle = window.setInterval(update, 1000);
}

async function leaveMeeting(showLobbyAfter = true) {
  state.meetingActive = false;
  state.joinedRoom = false;
  window.clearInterval(state.timerHandle);
  if (state.clientId && state.roomId) roomApi('leave').catch(() => {});
  state.pollGeneration += 1;
  for (const socketId of [...state.peers.keys()]) removePeer(socketId);
  if (state.screenStream) state.screenStream.getTracks().forEach((track) => track.stop());
  stopBackgroundProcessor();
  state.rawStream?.getTracks().forEach((track) => track.stop());
  state.canvasStream?.getTracks().forEach((track) => track.stop());
  state.rawStream = null;
  state.screenStream = null;
  state.cameraOutputTrack = null;
  state.canvasStream = null;
  state.clientId = null;
  state.roomId = null;
  state.sharing = false;
  $('#shareButton').classList.remove('active');
  $('#shareButton').setAttribute('aria-pressed', 'false');
  $('#shareButton').setAttribute('aria-label', 'Share screen');
  $('#videoGrid').replaceChildren();
  $('#sidePanel').classList.add('hidden');
  if (showLobbyAfter) showLobby();
}

function updateMicButton() {
  const button = $('#micButton');
  const icon = button?.querySelector('.mic-control-icon');
  if (!button || !icon) return;
  const muted = !state.micEnabled;
  icon.textContent = '🎙️';
  icon.classList.toggle('muted', muted);
  button.classList.toggle('off', muted);
  button.setAttribute('aria-pressed', String(muted));
  button.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
}

function toggleMic() {
  const track = state.rawStream?.getAudioTracks()[0];
  if (!track) return toast('No microphone was found.', 'error');
  state.micEnabled = !state.micEnabled;
  track.enabled = state.micEnabled;
  updateMicButton();
  broadcastMediaState();
}

function toggleCamera() {
  const rawTrack = state.rawStream?.getVideoTracks()[0];
  if (!rawTrack) return toast('No camera was found.', 'error');
  state.cameraEnabled = !state.cameraEnabled;
  rawTrack.enabled = state.cameraEnabled;
  if (state.cameraOutputTrack && state.cameraOutputTrack !== rawTrack) state.cameraOutputTrack.enabled = state.cameraEnabled;
  $('#cameraButton').classList.toggle('off', !state.cameraEnabled);
  $('#cameraButton .control-icon').textContent = state.cameraEnabled ? '📷' : '🚫';
  broadcastMediaState();
}

async function replaceVideoTrackForPeers(track) {
  const operations = [];
  state.peers.forEach(({ pc }) => {
    if (!pc) return;
    const sender = pc.getSenders().find((item) => item.track?.kind === 'video' || (!item.track && item.transport));
    if (sender) operations.push(sender.replaceTrack(track));
    else if (track) {
      const stream = getOutgoingStream(track);
      pc.addTrack(track, stream);
    }
  });
  await Promise.allSettled(operations);
}

async function toggleScreenShare() {
  if (state.sharing) return stopScreenShare();
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Screen sharing is not supported in this browser.', 'error');
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    const track = state.screenStream.getVideoTracks()[0];
    track.addEventListener('ended', stopScreenShare, { once: true });
    state.sharing = true;
    await replaceVideoTrackForPeers(track);
    $('#shareButton').classList.add('active');
    $('#shareButton').setAttribute('aria-pressed', 'true');
    $('#shareButton').setAttribute('aria-label', 'Stop sharing screen');
    broadcastMediaState();
  } catch (error) {
    if (error.name !== 'NotAllowedError') toast('Screen sharing could not start.', 'error');
  }
}

async function stopScreenShare() {
  if (!state.sharing) return;
  state.sharing = false;
  const tracks = state.screenStream?.getTracks() || [];
  state.screenStream = null;
  await replaceVideoTrackForPeers(state.cameraOutputTrack);
  tracks.forEach((track) => track.stop());
  $('#shareButton').classList.remove('active');
  $('#shareButton').setAttribute('aria-pressed', 'false');
  $('#shareButton').setAttribute('aria-label', 'Share screen');
  broadcastMediaState();
}

function showReaction(emoji) {
  const element = document.createElement('div');
  element.className = 'floating-reaction';
  element.textContent = emoji;
  element.style.setProperty('--reaction-left', `${12 + Math.random() * 76}%`);
  $('#reactionLayer').append(element);
  window.setTimeout(() => element.remove(), 2900);
}

function addChatMessage(message) {
  if (!message || !message.text || !message.user) return;
  const messageId = String(message.id || '');
  if (messageId && state.seenMessageIds.has(messageId)) return;
  if (messageId) {
    state.seenMessageIds.add(messageId);
    if (state.seenMessageIds.size > 500) {
      const oldest = state.seenMessageIds.values().next().value;
      state.seenMessageIds.delete(oldest);
    }
  }

  const container = $('#chatMessages');
  container.querySelector('.empty-panel')?.remove();
  const article = document.createElement('article');
  const isOwnMessage = String(message.user.id || '') === String(state.user?.id || '');
  article.className = `chat-message${isOwnMessage ? ' own-message' : ''}`;
  const parsedDate = new Date(message.sentAt || Date.now());
  const time = Number.isNaN(parsedDate.getTime())
    ? ''
    : parsedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  article.innerHTML = `<div class="chat-meta"><strong>${escapeHtml(isOwnMessage ? 'You' : message.user.name)}</strong><span>${escapeHtml(time)}</span></div><div class="chat-bubble">${escapeHtml(message.text)}</div>`;
  container.append(article);
  container.scrollTop = container.scrollHeight;
}

function renderPeople() {
  const list = $('#peopleList');
  list.replaceChildren();
  const entries = [...state.participants.entries()];
  $('#peopleCount').textContent = String(entries.length || 1);
  for (const [id, participant] of entries) {
    const row = document.createElement('article');
    row.className = 'person-row';
    const user = participant.user;
    const media = participant.media || {};
    const avatarMarkup = user.avatar
      ? `<div class="person-avatar has-image"><img src="${escapeHtml(user.avatar)}" alt=""></div>`
      : `<div class="person-avatar">${escapeHtml(initials(user.name))}</div>`;
    row.innerHTML = `
      ${avatarMarkup}
      <div class="person-info"><strong>${escapeHtml(user.name)}${id === 'local' ? ' (You)' : ''}</strong><span>${escapeHtml(user.email || '')}</span></div>
      <div class="person-media" title="Media status">${media.mic === false ? '🔇' : '🎙'} ${media.camera === false ? '🚫' : '📷'}</div>`;
    list.append(row);
  }
}

function selectPanel(tab) {
  const names = ['chat', 'people', 'background'];
  names.forEach((name) => {
    $(`#${name}Tab`).classList.toggle('active', name === tab);
    $(`#${name}Panel`).classList.toggle('hidden', name !== tab);
  });
  $('#sidePanel').classList.remove('hidden');
}

function getBackgroundOutputSize(video) {
  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 720;
  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / sourceWidth);
  const width = Math.max(320, Math.round((sourceWidth * scale) / 2) * 2);
  const height = Math.max(180, Math.round((sourceHeight * scale) / 2) * 2);
  return { width, height };
}

function ensureCanvasSize(canvas, width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function drawSourceCover(ctx, source, width, height) {
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width || width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height || height;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function fillSoftEllipse(ctx, centerX, centerY, radiusX, radiusY, innerStop = 0.58) {
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.scale(radiusX, radiusY);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(innerStop, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.86, 'rgba(255,255,255,.72)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPortraitMask(ctx, width, height) {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';

  // A soft head-and-shoulders portrait mask keeps the user visible without
  // downloading an external AI model. It is intentionally generous so normal
  // seated movement does not disappear at the edges.
  fillSoftEllipse(ctx, width * 0.50, height * 0.29, width * 0.17, height * 0.25, 0.52);
  fillSoftEllipse(ctx, width * 0.50, height * 0.73, width * 0.37, height * 0.53, 0.60);
  fillSoftEllipse(ctx, width * 0.34, height * 0.72, width * 0.19, height * 0.31, 0.58);
  fillSoftEllipse(ctx, width * 0.66, height * 0.72, width * 0.19, height * 0.31, 0.58);
  ctx.restore();
}

function drawBackground(ctx, width, height) {
  const rawVideo = $('#rawLocalVideo');
  if (state.backgroundMode === 'blur') {
    ctx.save();
    ctx.filter = 'blur(28px) saturate(.9) brightness(.86)';
    drawSourceCover(ctx, rawVideo, width, height);
    ctx.restore();
    return;
  }
  if (state.backgroundMode === 'upload' && state.backgroundImage) {
    drawSourceCover(ctx, state.backgroundImage, width, height);
    return;
  }
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  if (state.backgroundMode === 'ocean') {
    gradient.addColorStop(0, '#59dbef');
    gradient.addColorStop(.45, '#147eb1');
    gradient.addColorStop(1, '#052c58');
  } else if (state.backgroundMode === 'sunset') {
    gradient.addColorStop(0, '#ffc39d');
    gradient.addColorStop(.48, '#b45f87');
    gradient.addColorStop(1, '#172755');
  } else {
    gradient.addColorStop(0, '#f4f7fa');
    gradient.addColorStop(.45, '#c1d2e0');
    gradient.addColorStop(1, '#526d86');
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  if (state.backgroundMode === 'studio') {
    const glow = ctx.createRadialGradient(width * .5, height * .32, 0, width * .5, height * .32, width * .65);
    glow.addColorStop(0, 'rgba(255,255,255,.72)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
  }
}

function renderCompositedBackgroundFrame() {
  const video = $('#rawLocalVideo');
  if (!video || video.readyState < 2 || state.backgroundMode === 'none') return false;

  const { width, height } = getBackgroundOutputSize(video);
  const outputCanvas = $('#backgroundCanvas');
  const foregroundCanvas = $('#foregroundCanvas');
  const maskCanvas = $('#maskCanvas');
  ensureCanvasSize(outputCanvas, width, height);
  ensureCanvasSize(foregroundCanvas, width, height);
  ensureCanvasSize(maskCanvas, width, height);

  const output = outputCanvas.getContext('2d', { alpha: false });
  const foreground = foregroundCanvas.getContext('2d');
  const mask = maskCanvas.getContext('2d');

  drawPortraitMask(mask, width, height);

  foreground.save();
  foreground.clearRect(0, 0, width, height);
  foreground.globalCompositeOperation = 'source-over';
  foreground.filter = 'none';
  drawSourceCover(foreground, video, width, height);
  foreground.globalCompositeOperation = 'destination-in';
  foreground.drawImage(maskCanvas, 0, 0, width, height);
  foreground.restore();

  output.save();
  output.clearRect(0, 0, width, height);
  output.globalCompositeOperation = 'source-over';
  output.filter = 'none';
  drawBackground(output, width, height);
  output.drawImage(foregroundCanvas, 0, 0, width, height);
  output.restore();
  return true;
}

function scheduleBackgroundFrame(loopId) {
  const video = $('#rawLocalVideo');
  const renderNext = () => {
    if (loopId !== state.backgroundLoopId || state.backgroundMode === 'none') return;
    try {
      renderCompositedBackgroundFrame();
    } catch (error) {
      console.warn('Background frame could not be rendered:', error);
    }
    scheduleBackgroundFrame(loopId);
  };

  if (typeof video.requestVideoFrameCallback === 'function') {
    state.backgroundFrameApi = 'video';
    state.backgroundFrameHandle = video.requestVideoFrameCallback(renderNext);
  } else {
    state.backgroundFrameApi = 'animation';
    state.backgroundFrameHandle = window.requestAnimationFrame(renderNext);
  }
}

function stopBackgroundProcessor() {
  state.backgroundLoopId += 1;
  const video = $('#rawLocalVideo');
  if (state.backgroundFrameApi === 'video' && typeof video.cancelVideoFrameCallback === 'function' && state.backgroundFrameHandle) {
    try { video.cancelVideoFrameCallback(state.backgroundFrameHandle); } catch {}
  } else if (state.backgroundFrameApi === 'animation' && state.backgroundFrameHandle) {
    window.cancelAnimationFrame(state.backgroundFrameHandle);
  }
  state.backgroundFrameHandle = 0;
  state.backgroundFrameApi = null;
}

async function startBackgroundProcessor() {
  const video = $('#rawLocalVideo');
  const canvas = $('#backgroundCanvas');
  if (typeof canvas.captureStream !== 'function') throw new Error('This browser cannot create a virtual camera track.');

  renderCompositedBackgroundFrame();
  const needsNewStream = !state.canvasStream || state.canvasStream.getVideoTracks()[0]?.readyState === 'ended';
  if (needsNewStream) state.canvasStream = canvas.captureStream(24);
  const track = state.canvasStream.getVideoTracks()[0];
  if (!track) throw new Error('The background video track could not be created.');

  const trackChanged = state.cameraOutputTrack !== track;
  state.cameraOutputTrack = track;
  state.cameraOutputTrack.enabled = state.cameraEnabled;

  stopBackgroundProcessor();
  const loopId = ++state.backgroundLoopId;
  scheduleBackgroundFrame(loopId);

  if (!state.sharing && trackChanged) await replaceVideoTrackForPeers(track);
  updateLocalPreview();
}

async function applyBackground(mode, image = null) {
  if (!state.rawStream?.getVideoTracks().length) {
    toast('Turn on a camera to use backgrounds.', 'error');
    return;
  }

  $$('.background-option').forEach((button) => {
    const selected = button.dataset.background === mode || (mode === 'upload' && button.classList.contains('upload-option'));
    button.classList.toggle('selected', selected);
  });

  if (mode === 'none') {
    stopBackgroundProcessor();
    state.backgroundMode = 'none';
    const previousCanvasStream = state.canvasStream;
    const rawTrack = state.rawStream.getVideoTracks()[0];
    state.cameraOutputTrack = rawTrack;
    rawTrack.enabled = state.cameraEnabled;
    if (!state.sharing) await replaceVideoTrackForPeers(rawTrack);
    previousCanvasStream?.getTracks().forEach((track) => track.stop());
    state.canvasStream = null;
    updateLocalPreview();
    $('#backgroundStatus').textContent = 'Background effects are off.';
    return;
  }

  if (mode === 'upload' && !image && !state.backgroundImage) {
    toast('Choose an image first.', 'error');
    return;
  }

  if (image) state.backgroundImage = image;
  state.backgroundMode = mode;
  $('#backgroundStatus').textContent = 'Applying the background to your live camera…';

  try {
    await startBackgroundProcessor();
    const label = mode === 'upload' ? 'Uploaded image' : mode[0].toUpperCase() + mode.slice(1);
    $('#backgroundStatus').textContent = `${label} background is active on your live camera.`;
    toast(`${label} background applied.`);
  } catch (error) {
    console.error(error);
    stopBackgroundProcessor();
    state.backgroundMode = 'none';
    const rawTrack = state.rawStream.getVideoTracks()[0];
    state.cameraOutputTrack = rawTrack;
    if (!state.sharing) await replaceVideoTrackForPeers(rawTrack);
    updateLocalPreview();
    $('#backgroundStatus').textContent = 'Background processing is not supported by this browser.';
    toast(error.message || 'Virtual background could not start.', 'error');
  }
}

async function copyRoomCode() {
  try {
    await navigator.clipboard.writeText(state.roomId);
    toast('Meeting code copied.');
  } catch {
    const input = document.createElement('textarea');
    input.value = state.roomId;
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    toast('Meeting code copied.');
  }
}

async function handleJoin(roomId) {
  $('#lobbyError').textContent = '';
  try {
    await joinRoom(roomId);
  } catch (error) {
    $('#lobbyError').textContent = error.message;
    toast(error.message, 'error');
  }
}

function bindEvents() {
  $('#loginTab').addEventListener('click', () => setAuthTab('login'));
  $('#registerTab').addEventListener('click', () => setAuthTab('register'));

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#loginError').textContent = '';
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email: usernameToEmail($('#loginUsername').value), password: $('#loginPassword').value }),
      });
      state.user = data.user;
      state.accounts = data.accounts || [data.user];
      showLobby();
    } catch (error) {
      $('#loginError').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#registerError').textContent = '';
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ name: $('#registerName').value, email: usernameToEmail($('#registerUsername').value), password: $('#registerPassword').value }),
      });
      state.user = data.user;
      state.accounts = data.accounts || [data.user];
      showLobby();
      toast('Your @dexa.online account is ready.');
    } catch (error) {
      $('#registerError').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#profileMenuButton').addEventListener('click', (event) => {
    event.stopPropagation();
    const dropdown = $('#profileDropdown');
    const opening = dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden', !opening);
    $('#profileMenuButton').setAttribute('aria-expanded', String(opening));
  });

  $('#profileDropdown').addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', closeProfileMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeProfileMenu();
  });

  $('#accountList').addEventListener('click', async (event) => {
    const button = event.target.closest('.account-option');
    if (!button || button.disabled) return;
    button.disabled = true;
    try { await switchAccount(button.dataset.userId); }
    catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });

  $('#addAccountButton').addEventListener('click', beginAddAccount);
  $('#cancelAddAccountButton').addEventListener('click', () => {
    state.addingAccount = false;
    showLobby();
  });
  $('#editProfileButton').addEventListener('click', openProfileEditor);
  $('#sideEditProfileButton').addEventListener('click', openProfileEditor);
  $('#sideManageAccountsButton').addEventListener('click', async () => {
    if (state.meetingActive) await leaveMeeting(true);
    else showLobby();
    window.requestAnimationFrame(openProfileMenu);
  });

  $('#logoutCurrentButton').addEventListener('click', async () => {
    try {
      const data = await api('/api/logout', { method: 'POST' });
      state.user = data.user;
      state.accounts = data.accounts || [];
      if (state.user) {
        showLobby();
        toast('Current account logged out.');
      } else {
        closeProfileMenu();
        showView('auth');
        setAuthTab('login');
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  $('#logoutAllButton').addEventListener('click', async () => {
    try {
      await api('/api/logout-all', { method: 'POST' });
      state.user = null;
      state.accounts = [];
      closeProfileMenu();
      showView('auth');
      setAuthTab('login');
      toast('All accounts logged out.');
    } catch (error) { toast(error.message, 'error'); }
  });

  $('#profileAvatarInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    $('#profileError').textContent = '';
    try {
      state.profileAvatarData = await imageFileToDataUrl(file);
      state.removeProfileAvatar = false;
      $('#profileAvatarPreview').src = state.profileAvatarData;
      $('#profileAvatarPreview').classList.remove('hidden');
      $('#profileAvatarFallback').classList.add('hidden');
      $('#removeProfileAvatarButton').classList.remove('hidden');
    } catch (error) {
      $('#profileError').textContent = error.message;
      event.target.value = '';
    }
  });

  $('#removeProfileAvatarButton').addEventListener('click', () => {
    state.profileAvatarData = null;
    state.removeProfileAvatar = true;
    $('#profileAvatarPreview').classList.add('hidden');
    $('#profileAvatarFallback').textContent = initials($('#profileNameInput').value || state.user.name);
    $('#profileAvatarFallback').classList.remove('hidden');
    $('#removeProfileAvatarButton').classList.add('hidden');
  });

  $('#cancelProfileButton').addEventListener('click', () => $('#profileDialog').close());
  $('#profileForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#profileError').textContent = '';
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = await api('/api/profile', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#profileNameInput').value,
          avatarData: state.profileAvatarData,
          removeAvatar: state.removeProfileAvatar,
        }),
      });
      state.user = data.user;
      state.accounts = data.accounts || [data.user];
      $('#profileDialog').close();
      renderProfileBars();
      renderAccountList();
      if (state.meetingActive) refreshLocalProfileInMeeting();
      else showLobby();
      toast('Profile updated successfully.');
    } catch (error) {
      $('#profileError').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#meetingCode').addEventListener('input', (event) => { event.target.value = formatRoomInput(event.target.value); });
  $('#joinForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const roomId = normalizeRoomId($('#meetingCode').value);
    if (!roomId) return $('#lobbyError').textContent = 'Enter a complete meeting code.';
    handleJoin(roomId);
  });

  $('#newMeetingButton').addEventListener('click', async () => {
    try {
      const data = await api('/api/meetings', { method: 'POST', body: '{}' });
      await handleJoin(data.roomId);
    } catch (error) {
      $('#lobbyError').textContent = error.message;
    }
  });

  $('#copyRoomButton').addEventListener('click', copyRoomCode);
  $('#micButton').addEventListener('click', toggleMic);
  $('#cameraButton').addEventListener('click', toggleCamera);
  $('#shareButton').addEventListener('click', toggleScreenShare);
  $('#leaveButton').addEventListener('click', () => leaveMeeting(true));

  $('#panelButton').addEventListener('click', () => {
    const opening = $('#sidePanel').classList.contains('hidden');
    if (opening) selectPanel('background');
    else $('#sidePanel').classList.add('hidden');
  });
  $('#chatTab').addEventListener('click', () => selectPanel('chat'));
  $('#peopleTab').addEventListener('click', () => selectPanel('people'));
  $('#backgroundTab').addEventListener('click', () => selectPanel('background'));

  $('#chatForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = $('#chatInput');
    const sendButton = form.querySelector('button[type="submit"]');
    const text = input.value.trim();
    if (!text) return;
    if (!state.meetingActive || !state.clientId) {
      toast('Live chat is reconnecting. Try again in a moment.', 'error');
      return;
    }

    sendButton.disabled = true;
    try {
      const result = await broadcastEvent('chat-message', { text });
      if (!result?.message) throw new Error('Message was not confirmed by the server.');
      addChatMessage(result.message);
      input.value = '';
      input.focus();
    } catch (error) {
      toast(error.message || 'Message could not be sent.', 'error');
      input.focus();
    } finally {
      sendButton.disabled = false;
    }
  });

  $('#reactionButton').addEventListener('click', () => {
    const menu = $('#reactionMenu');
    const hidden = menu.classList.toggle('hidden');
    $('#reactionButton').setAttribute('aria-expanded', String(!hidden));
  });
  $$('#reactionMenu button').forEach((button) => button.addEventListener('click', () => {
    const emoji = button.textContent;
    broadcastEvent('reaction', { emoji }).catch((error) => toast(error.message || 'Reaction could not be sent.', 'error'));
    $('#reactionMenu').classList.add('hidden');
    $('#reactionButton').setAttribute('aria-expanded', 'false');
  }));

  $$('.background-option[data-background]').forEach((button) => button.addEventListener('click', () => applyBackground(button.dataset.background)));
  $('#backgroundUpload').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast('Choose an image smaller than 8 MB.', 'error');
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); applyBackground('upload', image); };
    image.onerror = () => { URL.revokeObjectURL(url); toast('That background image could not be opened.', 'error'); };
    image.src = url;
  });

  window.addEventListener('beforeunload', () => {
    if (state.meetingActive && state.clientId) navigator.sendBeacon?.(`/api/rooms/${encodeURIComponent(state.roomId)}/leave`, new Blob([JSON.stringify({ clientId: state.clientId })], { type: 'application/json' }));
  });
}

async function initialize() {
  bindEvents();
  try {
    const data = await api('/api/me');
    state.user = data.user;
    state.accounts = data.accounts || [data.user];
    showLobby();
  } catch {
    showView('auth');
  }
}

initialize();
