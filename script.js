/* ════════════════════════════════════════════════════
   GESTURE ARENA — COMPLETE GAME ENGINE
   ════════════════════════════════════════════════════ */
'use strict';

/* ── GLOBAL SETTINGS ─────────────────────────────── */
const Settings = {
  sound: true,
  music: true,
  shake: true,
  particles: true,
  confidenceThreshold: 0.75,
  winScore: 5,
};

/* ── GAME STATE ──────────────────────────────────── */
const State = {
  screen: 'loading',
  playerScore: 0,
  aiScore: 0,
  round: 0,
  combo: 0,
  bestCombo: 0,
  totalRounds: 0,
  gestureReady: false,
  handDetected: false,
  currentGesture: null,
  lastGesture: null,
  gestureConfidence: 0,
  battlePhase: 'idle', // idle | detecting | reveal | cooldown
  highScore: parseInt(localStorage.getItem('ga_highscore') || '0'),

  // ── AI Brain state (never exposed to player) ──────
  ai: {
    consecutiveLosses: 0,   // AI's consecutive losses (player wins)
    consecutiveWins: 0,     // AI's consecutive wins
    playerMoveHistory: [],  // last 6 player moves — pattern scouting
    momentum: 0,            // -1..+1 how favoured the AI currently feels
    lastAiMove: null,
    drawBudget: 0,          // internal draw quota counter
  },
};

/* ── CURSOR ──────────────────────────────────────── */
document.addEventListener('mousemove', e => {
  document.documentElement.style.setProperty('--mx', e.clientX + 'px');
  document.documentElement.style.setProperty('--my', e.clientY + 'px');
});

/* ════════════════════════════════════════════════════
   AUDIO ENGINE
   ════════════════════════════════════════════════════ */
const Audio = (() => {
  let ctx = null;
  let musicNode = null;
  let musicGain = null;
  let unlocked = false;

  function unlock() {
    if (unlocked) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    unlocked = true;
    document.getElementById('audio-unlock').classList.add('hidden');
    startAmbient();
  }

  function startAmbient() {
    if (!Settings.music || !ctx) return;
    musicGain = ctx.createGain();
    musicGain.gain.setValueAtTime(0, ctx.currentTime);
    musicGain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 2);
    musicGain.connect(ctx.destination);

    function playDroneLayer(freq, type, gainVal) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = gainVal;
      osc.connect(g);
      g.connect(musicGain);
      osc.start();
      // subtle drift
      setInterval(() => {
        osc.frequency.linearRampToValueAtTime(
          freq + (Math.random() - 0.5) * 2,
          ctx.currentTime + 4
        );
      }, 4000);
    }

    playDroneLayer(55, 'sine', 0.8);
    playDroneLayer(82.5, 'sine', 0.4);
    playDroneLayer(110, 'triangle', 0.2);
  }

  function setMusicVolume(v) {
    if (!musicGain) return;
    musicGain.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.5);
  }

  function tone(freq, duration, type = 'sine', vol = 0.3) {
    if (!Settings.sound || !ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(g); g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  }

  function play(name) {
    if (!Settings.sound || !ctx) return;
    switch (name) {
      case 'click': tone(880, 0.08, 'square', 0.15); break;
      case 'hover': tone(660, 0.05, 'sine', 0.07); break;
      case 'countdown': tone(440, 0.3, 'sawtooth', 0.25); break;
      case 'go': tone(880, 0.6, 'sawtooth', 0.4); tone(1100, 0.5, 'square', 0.3); break;
      case 'win':
        tone(523, 0.15, 'sine', 0.3);
        setTimeout(() => tone(659, 0.15, 'sine', 0.3), 150);
        setTimeout(() => tone(784, 0.4, 'sine', 0.4), 300);
        break;
      case 'lose':
        tone(220, 0.2, 'sawtooth', 0.3);
        setTimeout(() => tone(185, 0.4, 'sawtooth', 0.25), 200);
        break;
      case 'draw': tone(440, 0.3, 'triangle', 0.2); break;
      case 'detect': tone(1200, 0.06, 'sine', 0.15); break;
      case 'victory':
        [523, 659, 784, 1046].forEach((f, i) =>
          setTimeout(() => tone(f, 0.4, 'sine', 0.35), i * 100)
        );
        break;
      case 'defeat':
        [440, 392, 330, 262].forEach((f, i) =>
          setTimeout(() => tone(f, 0.4, 'sawtooth', 0.25), i * 120)
        );
        break;
      case 'combo': tone(1400 + State.combo * 80, 0.12, 'sine', 0.2); break;
    }
  }

  document.addEventListener('click', unlock, { once: true });
  document.addEventListener('touchstart', unlock, { once: true });

  return { play, unlock, setMusicVolume };
})();

/* ════════════════════════════════════════════════════
   CANVAS BACKGROUND ENGINE (Three.js starfield)
   ════════════════════════════════════════════════════ */
const BgEngine = (() => {
  const renderers = {};
  const scenes = {};
  const cameras = {};
  const objects = {};

  function initCanvas(id) {
    const canvas = document.getElementById(id);
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;

    // Stars
    const starGeo = new THREE.BufferGeometry();
    const starCount = 1200;
    const pos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i++) {
      pos[i] = (Math.random() - 0.5) * 200;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.25, transparent: true, opacity: 0.6 });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // Nebula planes
    const nebula1 = createNebulaPlane(0x440088, -6, -4, -20, 40, 30);
    const nebula2 = createNebulaPlane(0x004466, 5, 3, -25, 35, 25);
    scene.add(nebula1, nebula2);

    // Floating rings
    const rings = [];
    for (let i = 0; i < 4; i++) {
      const geo = new THREE.TorusGeometry(1.5 + i * 0.8, 0.015, 8, 80);
      const mat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0x00f5ff : 0xb400ff,
        transparent: true, opacity: 0.12
      });
      const torus = new THREE.Mesh(geo, mat);
      torus.position.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, -8 - i * 3);
      torus.rotation.x = Math.random() * Math.PI;
      scene.add(torus);
      rings.push(torus);
    }

    // Meteors
    const meteors = [];
    for (let i = 0; i < 5; i++) {
      const m = createMeteor();
      scene.add(m.line);
      meteors.push(m);
    }

    renderers[id] = renderer;
    scenes[id] = scene;
    cameras[id] = camera;
    objects[id] = { stars, rings, meteors, nebula1, nebula2 };
  }

  function createNebulaPlane(color, x, y, z, w, h) {
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    return mesh;
  }

  function createMeteor() {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array([0, 0, 0, 2, 0.5, 0]);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x00f5ff, transparent: true, opacity: 0 });
    const line = new THREE.Line(geo, mat);
    resetMeteor(line);
    return { line, timer: Math.random() * 8 };
  }

  function resetMeteor(line) {
    line.position.set((Math.random() - 0.5) * 30, 8 + Math.random() * 5, -10 - Math.random() * 10);
    line.rotation.z = -0.4 - Math.random() * 0.3;
    line.material.opacity = 0;
    line._vx = -0.1 - Math.random() * 0.15;
    line._vy = -0.08 - Math.random() * 0.1;
    line._active = false;
    line._delay = Math.random() * 8;
  }

  let globalTime = 0;
  function tick(dt) {
    globalTime += dt;
    for (const id of Object.keys(renderers)) {
      const r = renderers[id];
      const sc = scenes[id];
      const cam = cameras[id];
      const obs = objects[id];
      if (!obs) continue;

      obs.stars.rotation.y += 0.0001;
      obs.stars.rotation.x += 0.00005;

      obs.rings.forEach((ring, i) => {
        ring.rotation.x += 0.003 + i * 0.001;
        ring.rotation.y += 0.002;
      });

      obs.meteors.forEach(m => {
        m.timer += dt;
        if (m.timer > m.line._delay && !m.line._active) {
          m.line._active = true;
          m.line.material.opacity = 0.7;
        }
        if (m.line._active) {
          m.line.position.x += m.line._vx;
          m.line.position.y += m.line._vy;
          m.line.material.opacity -= 0.008;
          if (m.line.material.opacity <= 0) {
            resetMeteor(m.line);
            m.timer = 0;
          }
        }
      });

      r.render(sc, cam);
    }
  }

  function resize() {
    for (const id of Object.keys(renderers)) {
      renderers[id].setSize(window.innerWidth, window.innerHeight);
      cameras[id].aspect = window.innerWidth / window.innerHeight;
      cameras[id].updateProjectionMatrix();
    }
  }

  window.addEventListener('resize', resize);

  let lastTime = performance.now();
  function loop(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    tick(dt);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  return { init: initCanvas };
})();

/* ════════════════════════════════════════════════════
   PARTICLE SYSTEM
   ════════════════════════════════════════════════════ */
const Particles = (() => {
  let canvas, ctx, particles = [];

  function init() {
    canvas = document.getElementById('particle-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resize();
    requestAnimationFrame(loop);
  }

  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function burst(x, y, count, color, spread = 120) {
    if (!Settings.particles) return;
    for (let i = 0; i < count; i++) {
      const angle = (Math.random() * Math.PI * 2);
      const speed = 2 + Math.random() * spread * 0.1;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - Math.random() * 3,
        life: 1, decay: 0.02 + Math.random() * 0.02,
        size: 2 + Math.random() * 4,
        color,
        trail: [],
      });
    }
  }

  function shockwave(x, y, color) {
    if (!Settings.particles) return;
    for (let i = 0; i < 60; i++) {
      const angle = (i / 60) * Math.PI * 2;
      const speed = 5 + Math.random() * 8;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1, decay: 0.03 + Math.random() * 0.02,
        size: 3 + Math.random() * 3,
        color,
        trail: [],
      });
    }
  }

  function loop() {
    if (!ctx) { requestAnimationFrame(loop); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 6) p.trail.shift();

      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.12;
      p.vx *= 0.97;
      p.life -= p.decay;

      if (p.life <= 0) { particles.splice(i, 1); continue; }

      // trail
      if (p.trail.length > 1) {
        ctx.beginPath();
        ctx.moveTo(p.trail[0].x, p.trail[0].y);
        for (let t = 1; t < p.trail.length; t++) {
          ctx.lineTo(p.trail[t].x, p.trail[t].y);
        }
        ctx.strokeStyle = p.color.replace('1)', `${p.life * 0.3})`);
        ctx.lineWidth = p.size * 0.5;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fillStyle = p.color.replace('1)', `${p.life})`);
      ctx.shadowBlur = 10;
      ctx.shadowColor = p.color;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', resize);
  return { init, burst, shockwave };
})();

/* ════════════════════════════════════════════════════
   SCREEN MANAGER
   ════════════════════════════════════════════════════ */
const Screens = (() => {
  let current = null;

  function goTo(id) {
    const screens = document.querySelectorAll('.screen');
    screens.forEach(s => s.classList.remove('active'));
    const next = document.getElementById('screen-' + id);
    if (next) {
      next.classList.add('active');
      current = id;
    }
  }

  function getCurrent() { return current; }
  return { goTo, getCurrent };
})();

/* ════════════════════════════════════════════════════
   GESTURE DETECTOR (MediaPipe Hands)
   ════════════════════════════════════════════════════ */
const GestureDetector = (() => {
  let hands = null;
  let camera = null;
  let videoEl = null;
  let canvasEl = null;
  let onResultCallback = null;
  let started = false;
  let lastGesture = null;
  let gestureHoldCount = 0;
  const HOLD_FRAMES = 8;

  function isFingerExtended(landmarks, tip, pip) {
    return landmarks[tip].y < landmarks[pip].y;
  }

  function classifyGesture(landmarks) {
    const indexExt = isFingerExtended(landmarks, 8, 6);
    const middleExt = isFingerExtended(landmarks, 12, 10);
    const ringExt = isFingerExtended(landmarks, 16, 14);
    const pinkyExt = isFingerExtended(landmarks, 20, 18);

    // Thumb: check if tip is away from index base
    const thumbTip = landmarks[4];
    const thumbBase = landmarks[2];
    const thumbExt = Math.abs(thumbTip.x - thumbBase.x) > 0.06;

    const extended = [indexExt, middleExt, ringExt, pinkyExt].filter(Boolean).length;

    if (!indexExt && !middleExt && !ringExt && !pinkyExt) return 'rock';
    if (indexExt && middleExt && ringExt && pinkyExt) return 'paper';
    if (indexExt && middleExt && !ringExt && !pinkyExt) return 'scissors';
    return null;
  }

  function drawLandmarks(ctx, landmarks, w, h) {
    // Connections
    const connections = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],[0,17]
    ];

    ctx.clearRect(0, 0, w, h);

    connections.forEach(([a, b]) => {
      const la = landmarks[a], lb = landmarks[b];
      ctx.beginPath();
      ctx.moveTo(la.x * w, la.y * h);
      ctx.lineTo(lb.x * w, lb.y * h);
      ctx.strokeStyle = 'rgba(0,245,255,0.5)';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(0,245,255,0.8)';
      ctx.stroke();
    });

    landmarks.forEach((lm, i) => {
      ctx.beginPath();
      ctx.arc(lm.x * w, lm.y * h, i === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? 'rgba(180,0,255,0.9)' : 'rgba(0,245,255,0.9)';
      ctx.shadowBlur = 8;
      ctx.shadowColor = 'rgba(0,245,255,1)';
      ctx.fill();
      ctx.shadowBlur = 0;
    });
  }

  function onResults(results) {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    const w = canvasEl.width, h = canvasEl.height;
    ctx.clearRect(0, 0, w, h);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      const landmarks = results.multiHandLandmarks[0];
      const confidence = results.multiHandedness && results.multiHandedness[0]
        ? results.multiHandedness[0].score : 0;

      drawLandmarks(ctx, landmarks, w, h);

      const gesture = classifyGesture(landmarks);
      State.gestureConfidence = confidence;
      State.handDetected = true;

      if (gesture === lastGesture) {
        gestureHoldCount++;
      } else {
        gestureHoldCount = 0;
        lastGesture = gesture;
      }

      if (gestureHoldCount >= HOLD_FRAMES && confidence >= Settings.confidenceThreshold) {
        State.currentGesture = gesture;
        if (onResultCallback) onResultCallback(gesture, confidence, landmarks);
      } else {
        State.currentGesture = null;
      }
    } else {
      State.handDetected = false;
      State.currentGesture = null;
      State.gestureConfidence = 0;
      if (onResultCallback) onResultCallback(null, 0, null);
    }
  }

  async function start(videoId, canvasId, callback) {
    if (started) { switchCanvas(canvasId, callback); return; }

    videoEl = document.getElementById(videoId);
    canvasEl = document.getElementById(canvasId);
    onResultCallback = callback;
    started = true;

    hands = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.5,
    });
    hands.onResults(onResults);

    camera = new Camera(videoEl, {
      onFrame: async () => { await hands.send({ image: videoEl }); },
      width: 640, height: 480,
    });
    await camera.start();
  }

  function switchCanvas(canvasId, callback) {
    canvasEl = document.getElementById(canvasId);
    onResultCallback = callback;
  }

  function setCallback(cb) { onResultCallback = cb; }

  return { start, switchCanvas, setCallback };
})();

/* ════════════════════════════════════════════════════
   LOADING SCREEN LOGIC
   ════════════════════════════════════════════════════ */
function initLoading() {
  BgEngine.init('bg-canvas');

  const bar = document.getElementById('loading-bar');
  const status = document.getElementById('loading-status');
  const steps = [
    [10, 'Initializing Gesture Systems...'],
    [25, 'Loading Neural Networks...'],
    [40, 'Calibrating Hand Tracking...'],
    [55, 'Building Arena...'],
    [70, 'Generating Starfield...'],
    [85, 'Synthesizing Audio Engine...'],
    [95, 'Charging Energy Cores...'],
    [100, 'READY TO FIGHT'],
  ];

  let stepIdx = 0;
  function nextStep() {
    if (stepIdx >= steps.length) {
      setTimeout(() => showMenu(), 600);
      return;
    }
    const [pct, msg] = steps[stepIdx++];
    bar.style.width = pct + '%';
    status.textContent = msg;
    setTimeout(nextStep, 400 + Math.random() * 300);
  }

  spawnLoadingParticles();
  setTimeout(nextStep, 500);
}

function spawnLoadingParticles() {
  const cont = document.getElementById('particles-loading');
  if (!cont) return;
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.style.cssText = `
      position:absolute;
      width:${2 + Math.random() * 3}px;
      height:${2 + Math.random() * 3}px;
      border-radius:50%;
      background:${Math.random() > 0.5 ? '#00f5ff' : '#b400ff'};
      left:${Math.random() * 100}%;
      top:${Math.random() * 100}%;
      opacity:${0.2 + Math.random() * 0.5};
      box-shadow:0 0 8px currentColor;
      animation:float ${3 + Math.random() * 4}s ease-in-out infinite;
      animation-delay:${Math.random() * 4}s;
    `;
    cont.appendChild(p);
  }
}

/* ════════════════════════════════════════════════════
   MAIN MENU
   ════════════════════════════════════════════════════ */
function showMenu() {
  Screens.goTo('menu');
  BgEngine.init('bg-canvas-menu');
  document.getElementById('menu-highscore').textContent = State.highScore;
  spawnMenuOrbs();
}

function spawnMenuOrbs() {
  const cont = document.getElementById('menu-orbs');
  if (!cont) return;
  cont.innerHTML = '';
  const colors = ['rgba(0,245,255,0.08)', 'rgba(180,0,255,0.08)', 'rgba(255,0,144,0.06)'];
  for (let i = 0; i < 8; i++) {
    const orb = document.createElement('div');
    const size = 80 + Math.random() * 200;
    const color = colors[Math.floor(Math.random() * colors.length)];
    orb.style.cssText = `
      position:absolute;
      width:${size}px; height:${size}px;
      border-radius:50%;
      background:radial-gradient(circle, ${color}, transparent);
      left:${Math.random() * 100}%;
      top:${Math.random() * 100}%;
      filter:blur(${20 + Math.random() * 20}px);
      animation:float ${6 + Math.random() * 6}s ease-in-out infinite;
      animation-delay:${Math.random() * 4}s;
    `;
    cont.appendChild(orb);
  }
}

/* ════════════════════════════════════════════════════
   CALIBRATION
   ════════════════════════════════════════════════════ */
function showCalibration() {
  Screens.goTo('calibration');
  BgEngine.init('bg-canvas-calibration');

  const statusEl = document.getElementById('webcam-status');
  const confidenceFill = document.getElementById('confidence-fill');
  const confidencePct = document.getElementById('confidence-pct');
  const gestureEmoji = document.getElementById('gesture-detected-emoji');
  const gestureName = document.getElementById('gesture-detected-name');
  const btnReady = document.getElementById('btn-ready');
  const miniCards = {
    rock: document.getElementById('mini-rock'),
    paper: document.getElementById('mini-paper'),
    scissors: document.getElementById('mini-scissors'),
  };

  const gestureMap = {
    rock: { emoji: '✊', name: 'ROCK' },
    paper: { emoji: '✋', name: 'PAPER' },
    scissors: { emoji: '✌️', name: 'SCISSORS' },
  };

  let readyTimer = null;
  let handVisible = false;
  let gesturesDetected = new Set();

  GestureDetector.start('webcam-video', 'landmark-canvas', (gesture, conf, lm) => {
    const confPct = Math.round((conf || 0) * 100);
    confidenceFill.style.width = confPct + '%';
    confidencePct.textContent = confPct + '%';

    if (gesture) {
      Audio.play('detect');
      const g = gestureMap[gesture];
      gestureEmoji.textContent = g.emoji;
      gestureName.textContent = g.name;
      State.gestureReady = true;

      // highlight mini card
      Object.keys(miniCards).forEach(k => miniCards[k].classList.remove('active'));
      miniCards[gesture].classList.add('active');

      gesturesDetected.add(gesture);
      if (gesturesDetected.size >= 1 && !btnReady.disabled) {
        // already enabled
      } else if (gesturesDetected.size >= 1) {
        btnReady.disabled = false;
        btnReady.style.animation = 'float 2s ease-in-out infinite';
      }
    } else if (!lm) {
      gestureEmoji.textContent = '—';
      gestureName.textContent = 'Waiting for hand...';
      Object.keys(miniCards).forEach(k => miniCards[k].classList.remove('active'));
    }

    if (lm && !handVisible) {
      handVisible = true;
      statusEl.textContent = '● Hand Detected';
      btnReady.disabled = false;
    } else if (!lm && handVisible) {
      handVisible = false;
      statusEl.textContent = 'Show your hand...';
    }
  }).catch(err => {
    statusEl.textContent = 'Camera Error — Check Permissions';
    console.warn('Camera error:', err);
  });
}

/* ════════════════════════════════════════════════════
   COUNTDOWN
   ════════════════════════════════════════════════════ */
function startCountdown() {
  Screens.goTo('countdown');
  BgEngine.init('bg-canvas-countdown');
  GestureDetector.switchCanvas('battle-landmark-canvas', null);

  const numEl = document.getElementById('countdown-number');
  const instrEl = document.getElementById('countdown-instruction');
  const flareEl = document.getElementById('countdown-flare');

  const countdownSequence = [
    { val: '3', inst: 'GET READY', color: '#00f5ff' },
    { val: '2', inst: 'FOCUS...', color: '#b400ff' },
    { val: '1', inst: 'STEADY...', color: '#ff0090' },
    { val: 'FIGHT!', inst: 'SHOW YOUR MOVE', color: '#ff6a00' },
  ];

  let idx = 0;

  function nextCount() {
    if (idx >= countdownSequence.length) {
      startBattle();
      return;
    }

    const { val, inst, color } = countdownSequence[idx++];
    numEl.textContent = val;
    numEl.style.color = color;
    numEl.style.textShadow = `0 0 60px ${color}, 0 0 120px ${color}`;
    instrEl.textContent = inst;

    // animate
    numEl.style.animation = 'none';
    requestAnimationFrame(() => {
      numEl.style.animation = 'countPulse 0.8s ease-out both';
    });

    // flash
    flareEl.style.background = `radial-gradient(ellipse at center, ${color}22 0%, transparent 70%)`;
    gsap.to(flareEl, { opacity: 1, duration: 0.1, onComplete: () => {
      gsap.to(flareEl, { opacity: 0, duration: 0.4 });
    }});

    if (val !== 'FIGHT!') {
      Audio.play('countdown');
    } else {
      Audio.play('go');
    }

    setTimeout(nextCount, val === 'FIGHT!' ? 800 : 1000);
  }

  nextCount();
}

/* ════════════════════════════════════════════════════
   BATTLE ENGINE
   ════════════════════════════════════════════════════ */
const moves = ['rock', 'paper', 'scissors'];
const moveEmoji = { rock: '✊', paper: '✋', scissors: '✌️' };
const moveName = { rock: 'ROCK', paper: 'PAPER', scissors: 'SCISSORS' };

/* ════════════════════════════════════════════════════
   PSYCHOLOGICAL AI ENGINE
   Target outcomes per round: Win≈60%, Lose≈30%, Draw≈10%
   Achieved via weighted outcome sampling + natural noise
   ════════════════════════════════════════════════════ */
const AiBrain = (() => {

  // Given a player move, return the move that BEATS it (AI wins)
  const counterOf  = { rock: 'paper',    paper: 'scissors', scissors: 'rock'     };
  // Given a player move, return the move that LOSES to it (player wins)
  const weakTo     = { rock: 'scissors', paper: 'rock',     scissors: 'paper'    };

  /**
   * Compute a base outcome probability vector [pWin, pLose, pDraw]
   * from the current game state. These are then perturbed with noise
   * so no fixed pattern emerges.
   */
  function computeOutcomeBias(playerMove) {
    const ai = State.ai;

    // ── 1. Start from target baseline ─────────────────
    let pWin  = 0.60;   // player wins
    let pLose = 0.30;   // ai wins
    let pDraw = 0.10;   // draw

    // ── 2. Deficit recovery: player losing badly → help them ──
    const scoreDiff = State.aiScore - State.playerScore;
    if (scoreDiff >= 2) {
      // AI is leading — quietly ease off
      pWin  += 0.08 * Math.min(scoreDiff, 3);
      pLose -= 0.06 * Math.min(scoreDiff, 3);
    } else if (scoreDiff <= -2) {
      // Player is leading big — let AI claw back a bit (feels earned)
      pWin  -= 0.04 * Math.min(-scoreDiff, 2);
      pLose += 0.04 * Math.min(-scoreDiff, 2);
    }

    // ── 3. Consecutive loss momentum (AI losing streak → back off) ──
    if (ai.consecutiveLosses >= 3) {
      // AI has lost 3+ in a row — massively ease pressure
      pWin  += 0.12;
      pLose -= 0.10;
      pDraw += 0.02; // sprinkle a draw to keep it organic
    } else if (ai.consecutiveLosses === 2) {
      pWin  += 0.07;
      pLose -= 0.05;
    }

    // ── 4. Consecutive AI win momentum (AI on a streak → slip up) ──
    if (ai.consecutiveWins >= 2) {
      // AI has won 2+ in a row — make it stumble naturally
      pWin  += 0.10;
      pLose -= 0.08;
    }

    // ── 5. Draw budget — sprinkle draws to avoid monotony ──────────
    // Every ~5 rounds we "owe" a draw to break rhythm
    if (ai.drawBudget >= 4 && pDraw < 0.30) {
      pDraw += 0.18;
      pWin  -= 0.09;
      pLose -= 0.09;
    }

    // ── 6. Player combo excitement — let them keep it going ────────
    if (State.combo >= 2) {
      pWin  += 0.05;
      pLose -= 0.04;
      pDraw += 0.01; // slight draw chance feels cinematic here
    }

    // ── 7. Anti-repetition noise — jitter weights slightly ─────────
    const jitter = () => (Math.random() - 0.5) * 0.08;
    pWin  += jitter();
    pLose += jitter();
    pDraw += jitter();

    // ── 8. Clamp to valid probabilities ────────────────────────────
    pWin  = Math.max(0.18, Math.min(0.80, pWin));
    pLose = Math.max(0.08, Math.min(0.60, pLose));
    pDraw = Math.max(0.04, Math.min(0.28, pDraw));

    // Normalise to sum = 1
    const total = pWin + pLose + pDraw;
    return { pWin: pWin/total, pLose: pLose/total, pDraw: pDraw/total };
  }

  /**
   * Sample an outcome from the probability vector.
   * Returns 'win' | 'lose' | 'draw' from the AI's perspective of player.
   */
  function sampleOutcome(probs) {
    const r = Math.random();
    if (r < probs.pWin)             return 'win';   // player wins
    if (r < probs.pWin + probs.pDraw) return 'draw';
    return 'lose';                                   // ai wins
  }

  /**
   * Map a desired outcome to a concrete AI move, with believable variation.
   * If desired outcome is 'win' (player wins), we pick the move that LOSES.
   * We add occasional small mistakes so the result doesn't feel handed.
   */
  function pickMoveForOutcome(playerMove, desiredOutcome) {
    // 8% chance: AI makes a "human-like mistake" regardless of intent
    // This keeps things unpredictable and hides the system
    if (Math.random() < 0.08) {
      return moves[Math.floor(Math.random() * 3)];
    }

    if (desiredOutcome === 'win') {
      // Player should win → AI picks the move player beats
      // But 12% of the time pick random instead of perfectly losing
      // so it still feels like AI tried
      return Math.random() < 0.88 ? weakTo[playerMove] : moves[Math.floor(Math.random() * 3)];
    }

    if (desiredOutcome === 'draw') {
      return playerMove; // AI mirrors player
    }

    // desiredOutcome === 'lose' (AI wins)
    // Counter the player — but occasionally pick the losing move by "error"
    return Math.random() < 0.92 ? counterOf[playerMove] : weakTo[playerMove];
  }

  /**
   * Update AI brain state after a round resolves.
   */
  function updateAfterRound(outcome) {
    const ai = State.ai;

    if (outcome === 'win') {
      ai.consecutiveLosses++;
      ai.consecutiveWins  = 0;
      ai.drawBudget++;
    } else if (outcome === 'lose') {
      ai.consecutiveWins++;
      ai.consecutiveLosses = 0;
      ai.drawBudget++;
    } else {
      // draw resets both streaks but costs draw budget
      ai.consecutiveLosses = Math.max(0, ai.consecutiveLosses - 1);
      ai.consecutiveWins   = Math.max(0, ai.consecutiveWins   - 1);
      ai.drawBudget = 0; // draw was spent
    }

    // Record player move history (keep last 6)
    ai.playerMoveHistory.push(State.lastGesture);
    if (ai.playerMoveHistory.length > 6) ai.playerMoveHistory.shift();
  }

  /**
   * Main public API — given the player's move,
   * return the AI's chosen move and the expected outcome.
   */
  function decide(playerMove) {
    const probs          = computeOutcomeBias(playerMove);
    const desiredOutcome = sampleOutcome(probs);
    const aiMove         = pickMoveForOutcome(playerMove, desiredOutcome);

    // The actual outcome is determined by judge() later —
    // the "mistake" paths in pickMoveForOutcome can shift it.
    State.ai.lastAiMove = aiMove;
    return aiMove;
  }

  return { decide, updateAfterRound };
})();

function getAiMove(playerMove) {
  return AiBrain.decide(playerMove);
}

function judge(player, ai) {
  if (player === ai) return 'draw';
  if ((player === 'rock' && ai === 'scissors') ||
      (player === 'scissors' && ai === 'paper') ||
      (player === 'paper' && ai === 'rock')) return 'win';
  return 'lose';
}

function startBattle() {
  Screens.goTo('battle');
  BgEngine.init('bg-canvas-battle');
  Particles.init();

  // Reset round state
  State.battlePhase = 'idle';
  updateHUD();

  GestureDetector.switchCanvas('battle-landmark-canvas', onBattleGesture);
  document.getElementById('battle-status').textContent = 'Show your gesture!';

  scheduleBattleRound();
}

function scheduleBattleRound() {
  State.battlePhase = 'detecting';
  document.getElementById('battle-status').textContent = 'Show your gesture!';
  document.getElementById('player-emoji').textContent = '?';
  document.getElementById('ai-emoji').textContent = '?';
  document.getElementById('result-banner').classList.remove('visible');
  document.getElementById('result-banner').style.borderColor = 'rgba(0,245,255,0.5)';

  // Show AI thinking
  document.getElementById('ai-thinking').style.display = 'flex';
  document.getElementById('energy-bolt').style.opacity = '0';

  // Give 3 seconds to show gesture, then auto-pick
  let countdown = 3000;
  let detected = false;

  State._battleResolveTimer = setTimeout(() => {
    if (!detected) {
      // auto random if no gesture
      const fallback = moves[Math.floor(Math.random() * 3)];
      resolveRound(fallback);
    }
  }, countdown);

  State._battleDetectFlag = false;
}

let lastResolveTime = 0;

function onBattleGesture(gesture, conf, lm) {
  if (State.battlePhase !== 'detecting') return;
  if (!gesture) return;

  const now = Date.now();
  if (now - lastResolveTime < 1500) return;

  State._battleDetectFlag = true;
  clearTimeout(State._battleResolveTimer);
  resolveRound(gesture);
}

function resolveRound(playerMove) {
  if (State.battlePhase !== 'detecting') return;
  State.battlePhase = 'reveal';
  lastResolveTime = Date.now();
  State.lastGesture = playerMove;
  State.totalRounds++;

  const aiMove = getAiMove(playerMove);
  const outcome = judge(playerMove, aiMove);

  // Show moves
  gsap.to('#player-emoji', { scale: 1.3, duration: 0.2, onComplete: () => {
    document.getElementById('player-emoji').textContent = moveEmoji[playerMove];
    document.getElementById('player-fighter').querySelector('.player-glow').style.opacity = '1';
    gsap.to('#player-emoji', { scale: 1, duration: 0.3, ease: 'back.out(1.7)' });
  }});

  setTimeout(() => {
    document.getElementById('ai-thinking').style.display = 'none';
    gsap.to('#ai-emoji', { scale: 1.3, duration: 0.2, onComplete: () => {
      document.getElementById('ai-emoji').textContent = moveEmoji[aiMove];
      document.getElementById('ai-fighter').querySelector('.ai-glow').style.opacity = '1';
      gsap.to('#ai-emoji', { scale: 1, duration: 0.3, ease: 'back.out(1.7)' });
    }});
  }, 400);

  // Energy bolt
  setTimeout(() => {
    const boltEl = document.getElementById('energy-bolt');
    boltEl.style.opacity = '1';
    gsap.to(boltEl, { scale: 1.5, duration: 0.3, onComplete: () => {
      gsap.to(boltEl, { scale: 1, opacity: 0, duration: 0.4 });
    }});
  }, 700);

  // Result
  setTimeout(() => {
    showResult(outcome, playerMove, aiMove);
  }, 900);
}

function showResult(outcome, playerMove, aiMove) {
  State.round++;

  // ── Update AI brain momentum tracking ────────────
  AiBrain.updateAfterRound(outcome);

  const banner = document.getElementById('result-banner');
  const textEl = document.getElementById('result-text');
  const subEl = document.getElementById('result-sub');

  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;

  if (outcome === 'win') {
    State.playerScore++;
    State.combo++;
    if (State.combo > State.bestCombo) State.bestCombo = State.combo;
    textEl.textContent = State.combo > 1 ? `WIN × ${State.combo}` : 'WIN!';
    textEl.className = 'result-text win';
    subEl.textContent = `${moveName[playerMove]} beats ${moveName[aiMove]}`;
    banner.style.borderColor = 'rgba(0,255,136,0.6)';
    Audio.play('win');
    Particles.burst(cx * 0.3, cy, 30, 'rgba(0,255,136,');
    Particles.shockwave(cx * 0.3, cy, 'rgba(0,255,136,');
    screenShake();

    if (State.combo >= 3) {
      document.getElementById('combo-display').textContent = `🔥 ${State.combo}x COMBO!`;
      Audio.play('combo');
    }

    // Score pop
    const scoreEl = document.getElementById('player-score');
    scoreEl.classList.add('score-pop');
    setTimeout(() => scoreEl.classList.remove('score-pop'), 500);

  } else if (outcome === 'lose') {
    State.aiScore++;
    State.combo = 0;
    textEl.textContent = 'LOSE';
    textEl.className = 'result-text lose';
    subEl.textContent = `${moveName[aiMove]} beats ${moveName[playerMove]}`;
    banner.style.borderColor = 'rgba(255,34,85,0.6)';
    Audio.play('lose');
    Particles.burst(cx * 1.7, cy, 20, 'rgba(255,34,85,');
    screenShake();
    document.getElementById('combo-display').textContent = '';

    const aiScoreEl = document.getElementById('ai-score');
    aiScoreEl.classList.add('score-pop');
    setTimeout(() => aiScoreEl.classList.remove('score-pop'), 500);

  } else {
    textEl.textContent = 'DRAW';
    textEl.className = 'result-text draw';
    subEl.textContent = 'Both chose ' + moveName[playerMove];
    banner.style.borderColor = 'rgba(255,106,0,0.5)';
    Audio.play('draw');
    State.combo = 0;
    document.getElementById('combo-display').textContent = '';
  }

  banner.classList.add('visible');
  updateHUD();

  // Check win condition
  setTimeout(() => {
    if (State.playerScore >= Settings.winScore) {
      showGameOver(true);
    } else if (State.aiScore >= Settings.winScore) {
      showGameOver(false);
    } else {
      // Glow reset
      document.getElementById('player-fighter').querySelector('.player-glow').style.opacity = '0';
      document.getElementById('ai-fighter').querySelector('.ai-glow').style.opacity = '0';
      State.battlePhase = 'idle';
      setTimeout(scheduleBattleRound, 800);
    }
  }, 2200);
}

function updateHUD() {
  document.getElementById('player-score').textContent = State.playerScore;
  document.getElementById('ai-score').textContent = State.aiScore;
  document.getElementById('round-num').textContent = State.round + 1;

  // Lives (dots)
  const playerLives = document.getElementById('player-lives');
  const aiLives = document.getElementById('ai-lives');
  const total = Settings.winScore;

  playerLives.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('div');
    d.className = 'life-dot' + (i >= State.playerScore ? ' lost' : '');
    playerLives.appendChild(d);
  }
  aiLives.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('div');
    d.className = 'life-dot' + (i >= State.aiScore ? ' lost' : '');
    d.style.background = i < State.aiScore ? '#b400ff' : undefined;
    d.style.boxShadow = i < State.aiScore ? '0 0 6px #b400ff' : undefined;
    aiLives.appendChild(d);
  }
}

function screenShake() {
  if (!Settings.shake) return;
  const screen = document.getElementById('screen-battle');
  screen.classList.add('shake');
  setTimeout(() => screen.classList.remove('shake'), 400);
}

/* ════════════════════════════════════════════════════
   GAME OVER
   ════════════════════════════════════════════════════ */
function showGameOver(playerWon) {
  State.battlePhase = 'idle';

  const score = State.playerScore * 100 + (State.combo * 50) - (State.aiScore * 20);
  if (score > State.highScore) {
    State.highScore = score;
    localStorage.setItem('ga_highscore', score);
  }

  setTimeout(() => {
    Screens.goTo('gameover');
    BgEngine.init('bg-canvas-gameover');

    const badge = document.getElementById('gameover-badge');
    const titleEl = document.getElementById('gameover-title');
    const subEl = document.getElementById('gameover-sub');
    const emoji = document.getElementById('gameover-emoji');

    document.getElementById('stat-score').textContent = Math.max(0, score);
    document.getElementById('stat-rounds').textContent = State.totalRounds;
    document.getElementById('stat-combo').textContent = State.bestCombo;

    if (playerWon) {
      titleEl.textContent = 'VICTORY';
      titleEl.className = 'gameover-title victory';
      subEl.textContent = 'You dominated the Arena!';
      emoji.textContent = '🏆';
      Audio.play('victory');
      spawnVictoryParticles();
    } else {
      titleEl.textContent = 'DEFEAT';
      titleEl.className = 'gameover-title defeat';
      subEl.textContent = 'The AI reigns supreme...';
      emoji.textContent = '💀';
      Audio.play('defeat');
    }

    // Animate in
    gsap.from('.gameover-content', { opacity: 0, scale: 0.8, duration: 0.6, ease: 'back.out(1.5)' });
  }, 500);
}

function spawnVictoryParticles() {
  const cont = document.getElementById('victory-particles');
  if (!cont) return;
  const colors = ['#00f5ff', '#b400ff', '#ff0090', '#ff6a00', '#00ff88'];
  for (let i = 0; i < 60; i++) {
    const p = document.createElement('div');
    const color = colors[Math.floor(Math.random() * colors.length)];
    const size = 4 + Math.random() * 6;
    p.style.cssText = `
      position:absolute;
      width:${size}px; height:${size}px;
      border-radius:50%;
      background:${color};
      box-shadow:0 0 10px ${color};
      left:${Math.random() * 100}%;
      top:${Math.random() * 100}%;
      animation:float ${2 + Math.random() * 3}s ease-in-out infinite;
      animation-delay:${Math.random() * 2}s;
      opacity:${0.4 + Math.random() * 0.6};
    `;
    cont.appendChild(p);
  }
}

function resetGame() {
  State.playerScore = 0;
  State.aiScore = 0;
  State.round = 0;
  State.combo = 0;
  State.bestCombo = 0;
  State.totalRounds = 0;
  State.lastGesture = null;
  State.battlePhase = 'idle';

  // Reset AI brain
  State.ai.consecutiveLosses  = 0;
  State.ai.consecutiveWins    = 0;
  State.ai.playerMoveHistory  = [];
  State.ai.momentum           = 0;
  State.ai.lastAiMove         = null;
  State.ai.drawBudget         = 0;

  clearTimeout(State._battleResolveTimer);
  document.getElementById('combo-display').textContent = '';
  document.getElementById('victory-particles').innerHTML = '';
}

/* ════════════════════════════════════════════════════
   SETTINGS SCREEN
   ════════════════════════════════════════════════════ */
function initSettingsScreen() {
  BgEngine.init('bg-canvas-settings');

  const toggleSound = document.getElementById('toggle-sound');
  const toggleMusic = document.getElementById('toggle-music');
  const toggleShake = document.getElementById('toggle-shake');
  const toggleParticles = document.getElementById('toggle-particles');
  const sliderConf = document.getElementById('slider-confidence');
  const confVal = document.getElementById('confidence-val');

  toggleSound.addEventListener('change', () => Settings.sound = toggleSound.checked);
  toggleMusic.addEventListener('change', () => {
    Settings.music = toggleMusic.checked;
    Audio.setMusicVolume(Settings.music ? 0.18 : 0);
  });
  toggleShake.addEventListener('change', () => Settings.shake = toggleShake.checked);
  toggleParticles.addEventListener('change', () => Settings.particles = toggleParticles.checked);
  sliderConf.addEventListener('input', () => {
    Settings.confidenceThreshold = sliderConf.value / 100;
    confVal.textContent = sliderConf.value + '%';
  });
}

/* ════════════════════════════════════════════════════
   EVENT BINDINGS
   ════════════════════════════════════════════════════ */
function bindEvents() {
  // Hover sound on all buttons
  document.querySelectorAll('button, .btn-menu, .btn-back, .btn-ready').forEach(btn => {
    btn.addEventListener('mouseenter', () => Audio.play('hover'));
    btn.addEventListener('click', () => Audio.play('click'));
  });

  // Menu
  document.getElementById('btn-play').addEventListener('click', () => {
    showCalibration();
  });
  document.getElementById('btn-howto').addEventListener('click', () => {
    Screens.goTo('howto');
    BgEngine.init('bg-canvas-howto');
  });
  document.getElementById('btn-settings').addEventListener('click', () => {
    Screens.goTo('settings');
    initSettingsScreen();
  });

  // How to play back
  document.getElementById('btn-back-howto').addEventListener('click', showMenu);
  document.getElementById('btn-back-settings').addEventListener('click', showMenu);

  // Ready button
  document.getElementById('btn-ready').addEventListener('click', () => {
    startCountdown();
  });

  // Game over buttons
  document.getElementById('btn-play-again').addEventListener('click', () => {
    resetGame();
    startCountdown();
  });
  document.getElementById('btn-goto-menu').addEventListener('click', () => {
    resetGame();
    showMenu();
  });

  // Calibration screen back via keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (Screens.getCurrent() === 'howto' || Screens.getCurrent() === 'settings') {
        showMenu();
      }
    }
  });
}

/* ════════════════════════════════════════════════════
   AMBIENT BUTTON EFFECTS
   ════════════════════════════════════════════════════ */
function addButtonFX() {
  document.querySelectorAll('.btn-menu, .btn-ready').forEach(btn => {
    btn.addEventListener('mousemove', e => {
      const rect = btn.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      btn.style.setProperty('--bx', x + '%');
      btn.style.setProperty('--by', y + '%');
    });
  });
}

/* ════════════════════════════════════════════════════
   SCAN LINE ANIMATION
   ════════════════════════════════════════════════════ */
function animateScanLine() {
  const line = document.getElementById('scan-line');
  if (!line) return;
  let y = 0;
  let dir = 1;
  setInterval(() => {
    y += dir * 1.5;
    if (y > 100) dir = -1;
    if (y < 0) dir = 1;
    line.style.top = y + '%';
  }, 16);
}

/* ════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  addButtonFX();
  animateScanLine();
  initLoading();

  // Audio unlock overlay
  const overlay = document.getElementById('audio-unlock');
  overlay.addEventListener('click', () => {
    Audio.unlock();
    overlay.classList.add('hidden');
  });

  // Ambient glow pulse on battle arena
  setInterval(() => {
    if (Screens.getCurrent() !== 'battle') return;
    const bolt = document.getElementById('energy-bolt');
    if (bolt && State.battlePhase === 'detecting') {
      bolt.style.opacity = (0.3 + Math.sin(Date.now() * 0.003) * 0.3).toString();
    }
  }, 16);
});

/* ── Safety: handle MediaPipe not loading ─────────── */
window.addEventListener('error', e => {
  if (e.message && e.message.includes('Hands')) {
    console.warn('MediaPipe Hands failed to load — gesture detection unavailable.');
  }
});
