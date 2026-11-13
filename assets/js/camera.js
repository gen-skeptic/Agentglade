// A real viewfinder rather than relying on the optional file-input capture hint.
export function setupCamera({ addFiles, canAdd }) {
  const dialog = document.querySelector('#camera-dialog');
  const video = document.querySelector('#camera-video');
  const status = document.querySelector('#camera-status');
  const shutter = document.querySelector('#camera-shutter');
  const flip = document.querySelector('#camera-flip');
  let stream, generation = 0, facing = 'environment', capturing = false;
  function stop() {
    generation++;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    shutter.disabled = true;
  }
  function close() { if (dialog.open) dialog.close(); stop(); }
  function ready() {
    if (!stream || !dialog.open || video.readyState < 2) return;
    status.textContent = 'Ready to take a photo';
    shutter.disabled = false;
  }
  async function start() {
    stop();
    const token = generation;
    status.textContent = 'Opening camera… Allow camera access when asked.';
    flip.disabled = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      status.textContent = 'Live camera is unavailable in this browser. Use your phone camera below, or add a photo from Photos.';
      return;
    }
    try {
      const opened = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
      if (token !== generation || !dialog.open) { opened.getTracks().forEach((track) => track.stop()); return; }
      stream = opened;
      video.srcObject = stream;
      await video.play();
      if (token !== generation || !dialog.open) return;
      flip.disabled = false;
      ready();
    } catch (error) {
      if (token !== generation || !dialog.open) return;
      stop();
      status.textContent = error.name === 'NotAllowedError'
        ? 'Camera access is blocked. Allow Camera in this site’s browser permissions, or use your phone camera below.'
        : 'The camera could not open. Close other apps using it, or use your phone camera below.';
    }
  }
  async function capture() {
    if (!stream || capturing || !canAdd()) return;
    const token = generation;
    capturing = true; shutter.disabled = true; flip.disabled = true;
    status.textContent = 'Taking photo…';
    try {
      let blob;
      if ('ImageCapture' in window) {
        try { blob = await new ImageCapture(stream.getVideoTracks()[0]).takePhoto(); } catch { /* Capture a video frame on Safari and other unsupported devices. */ }
      }
      if (token !== generation || !dialog.open) return;
      if (!blob) {
        if (!video.videoWidth || !video.videoHeight) throw new Error('Camera is still starting.');
        const scale = Math.min(1, 3840 / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        canvas.width = canvas.height = 0;
      }
      if (token !== generation || !dialog.open) return;
      if (!blob) throw new Error('Photo capture failed.');
      addFiles([new File([blob], `agentglade-camera-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' })]);
      close();
    } catch {
      if (token === generation && dialog.open) { status.textContent = 'Could not capture the photo. Try again or use your phone camera below.'; shutter.disabled = false; flip.disabled = false; }
    } finally { capturing = false; }
  }
  document.querySelector('#open-camera').addEventListener('click', () => {
    if (!canAdd()) return;
    dialog.showModal();
    facing = 'environment';
    void start();
  });
  document.querySelector('#camera-close').addEventListener('click', close);
  dialog.addEventListener('close', stop);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  video.addEventListener('loadeddata', ready);
  shutter.addEventListener('click', capture);
  flip.addEventListener('click', () => { facing = facing === 'environment' ? 'user' : 'environment'; void start(); });
  document.querySelector('#pick-camera').addEventListener('click', close);
  document.querySelector('#pick-camera').addEventListener('change', (event) => {
    if (canAdd()) addFiles(event.target.files);
    event.target.value = '';
  });
  addEventListener('pagehide', close);
  document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
}
