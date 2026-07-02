/**
 * WebRTC peer connection helpers.
 * Uses Google's free STUN servers for NAT traversal.
 *
 * Flow:
 *   Host:  peer-joined → hostConnect() → create offer → send SDP → wait answer → done
 *   Joiner: joined → joinerConnect() → receive offer → send answer → done
 */

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

/**
 * Host side: called when server emits 'peer-joined'.
 * Creates offer, sends it, waits for answer.
 * Returns { dc } — the RTCDataChannel for game communication.
 */
export function hostConnect(socket) {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection(STUN_SERVERS);
    const dc = pc.createDataChannel('game');
    let settled = false;
    let remoteDescriptionSet = false;
    const iceCandidateQueue = [];

    function done(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off('signal', onSignal);
      if (err) reject(err);
      else resolve(result);
    }

    const timeout = setTimeout(() => {
      pc.close();
      done(new Error('WebRTC connection timed out.'));
    }, 30000);

    dc.onopen = () => done(null, { pc, dc });
    dc.onerror = (e) => console.error('Data channel error (host):', e);
    dc.onclose = () => {
      console.warn('Data channel closed (host)');
      done(new Error('Data channel closed unexpectedly'));
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        pc.close();
        done(new Error(
          'Connection failed. This usually happens with phone hotspots or corporate networks. Try connecting from a home WiFi network.'
        ));
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('signal', e.candidate);
      }
    };

    // Create and send the offer
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit('signal', { type: 'offer', sdp: pc.localDescription });
      })
      .catch((err) => done(err));

    // Signal handler — cleaned up by done()
    function onSignal(data) {
      (async () => {
        try {
          if (data.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            remoteDescriptionSet = true;
            // Process any ICE candidates queued before remote description was set
            while (iceCandidateQueue.length) {
              await pc.addIceCandidate(iceCandidateQueue.shift());
            }
          } else if (data.candidate) {
            if (remoteDescriptionSet) {
              await pc.addIceCandidate(new RTCIceCandidate(data));
            } else {
              iceCandidateQueue.push(new RTCIceCandidate(data));
            }
          }
        } catch (err) {
          console.warn('WebRTC signal error (host):', err);
        }
      })();
    }
    socket.on('signal', onSignal);
  });
}

/**
 * Joiner side: called immediately after 'joined'.
 * Waits for offer, creates answer, returns data channel.
 * Returns { dc } — the RTCDataChannel for game communication.
 */
export function joinerConnect(socket) {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection(STUN_SERVERS);
    let settled = false;
    let remoteDescriptionSet = false;
    const iceCandidateQueue = [];

    function done(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off('signal', onSignal);
      if (err) reject(err);
      else resolve(result);
    }

    const timeout = setTimeout(() => {
      pc.close();
      done(new Error('WebRTC connection timed out.'));
    }, 30000);

    pc.ondatachannel = (e) => {
      const dc = e.channel;
      dc.onopen = () => done(null, { pc, dc });
      dc.onerror = (e) => console.error('Data channel error (joiner):', e);
      dc.onclose = () => {
        console.warn('Data channel closed (joiner)');
        done(new Error('Data channel closed unexpectedly'));
      };
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        pc.close();
        done(new Error(
          'Connection failed. This usually happens with phone hotspots or corporate networks. Try connecting from a home WiFi network.'
        ));
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('signal', e.candidate);
      }
    };

    // Signal handler — cleaned up by done()
    function onSignal(data) {
      (async () => {
        try {
          if (data.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            remoteDescriptionSet = true;
            // Process any ICE candidates queued before remote description was set
            while (iceCandidateQueue.length) {
              await pc.addIceCandidate(iceCandidateQueue.shift());
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('signal', { type: 'answer', sdp: pc.localDescription });
          } else if (data.candidate) {
            if (remoteDescriptionSet) {
              await pc.addIceCandidate(new RTCIceCandidate(data));
            } else {
              iceCandidateQueue.push(new RTCIceCandidate(data));
            }
          }
        } catch (err) {
          console.warn('WebRTC signal error (joiner):', err);
        }
      })();
    }
    socket.on('signal', onSignal);
  });
}
