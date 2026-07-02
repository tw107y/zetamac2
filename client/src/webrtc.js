/**
 * WebRTC peer connection helpers.
 * Uses Google's free STUN server for NAT traversal.
 * No library needed — RTCPeerConnection is built into browsers.
 *
 * Flow:
 *   Host:  peer-joined → hostConnect() → create offer → send SDP → wait answer → done
 *   Joiner: joined → joinerConnect() → receive offer → send answer → done
 */

const STUN_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
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

    const timeout = setTimeout(() => {
      pc.close();
      reject(new Error('WebRTC connection timed out.'));
    }, 30000);

    dc.onopen = () => {
      clearTimeout(timeout);
      resolve({ pc, dc });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        clearTimeout(timeout);
        reject(new Error(
          'Connection failed. This usually happens with phone hotspots or corporate networks. Try connecting from a home WiFi network.'
        ));
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('signal', e.candidate); // relay raw ICE candidate
      }
    };

    // Create and send the offer
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        // Send the offer SDP to the joiner via the server
        socket.emit('signal', { type: 'offer', sdp: pc.localDescription });
      })
      .catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });

    // Listen for answer and ICE candidates from joiner
    socket.on('signal', async (data) => {
      try {
        if (data.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data));
        }
      } catch (err) {
        console.warn('WebRTC signal error (host):', err);
      }
    });
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

    const timeout = setTimeout(() => {
      pc.close();
      reject(new Error('WebRTC connection timed out.'));
    }, 30000);

    pc.ondatachannel = (e) => {
      const dc = e.channel;
      dc.onopen = () => {
        clearTimeout(timeout);
        resolve({ pc, dc });
      };
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        clearTimeout(timeout);
        reject(new Error(
          'Connection failed. This usually happens with phone hotspots or corporate networks. Try connecting from a home WiFi network.'
        ));
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('signal', e.candidate); // relay raw ICE candidate
      }
    };

    // Listen for offer and ICE candidates from host
    socket.on('signal', async (data) => {
      try {
        if (data.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          // Send the answer SDP back to the host
          socket.emit('signal', { type: 'answer', sdp: pc.localDescription });
        } else if (data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data));
        }
      } catch (err) {
        console.warn('WebRTC signal error (joiner):', err);
      }
    });
  });
}
