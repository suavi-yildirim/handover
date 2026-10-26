# CLAUDE.md — Handover (working title)

> Name meaning: a "handover" is a core robot care skill (handing a cup, medication, or tool to a person) and also what players do — hand their skills over to robots. Alternatives considered: Teach to Care, CareCraft, Kindly. Check trademarks and domains before public use.

This file gives Claude (and any collaborator) the full context of the project. Read it before writing code or making design decisions.

## 1. Vision

A free game (phone, browser, later Steam and Meta Quest 3) where players teach simulated robots everyday and care tasks. Every played episode becomes training data for open Vision-Language-Action (VLA) robot models.

**Problem addressed:** aging populations and a growing shortage of caregivers. Robots could help with daily tasks, but the main bottleneck is not hardware or models — it is the lack of large, diverse, high-quality demonstration data. Gamification lets many people produce that data cheaply.

**One-line pitch:** "Teach a robot to care — by playing a game."

## 2. Core concept

- Players control a simulated robot arm (phone as controller, keyboard/mouse on PC, Quest 3 for power users).
- Levels progress through environments: home (kitchen first) → hospital → school → more.
- Tasks are realistic daily and care activities: bring medication, hand over a cup safely, open a jar, tidy a fall hazard, set a table.
- The game score is designed to equal data quality, so players chasing high scores automatically produce good training data.
- Hook: "Train your own robot" — each player's robot learns from their demos and can compete on leaderboards; a "coach mode" lets players watch the trained model attempt tasks and correct it.
- Data is released as an open dataset (LeRobot-compatible).

## 3. Evaluating episodes (data quality)

The simulator knows the ground truth, so every episode can be checked automatically. Evaluate in layers:

1. **Task success** — each level defines success as predicates on sim state (e.g. cup on tray, upright, nothing spilled). Inspired by BEHAVIOR-style task definitions.
2. **Quality metrics** — completion time, smoothness (low jerk), collisions and contact forces (critical for care: never bump a patient), drops/regrasps, idle time.
3. **Physical plausibility / robot feasibility** — replay each episode with a realistic robot controller; discard trajectories a real robot couldn't execute (joint limits, excessive velocity, penetration, physics exploits).
4. **Player reputation** — hidden "gold" levels with known good solutions (reCAPTCHA-style); trusted players' data is weighted higher.
5. **Peer review / VLM judge** — for fuzzy qualities ("was the handover gentle?"), players rate replays as a game mode; a vision-language model can also judge.
6. **Data value** — track whether adding a batch of demos improves the trained policy, per player and per level.

**Design rule:** game score = data-quality score.

## 4. How the model learns by itself (training loop)

1. **Imitation learning** — fine-tune a VLA (SmolVLA) on filtered demos.
2. **Reinforcement learning in sim** — the same success predicates serve as rewards; the policy practices autonomously, starting from human demos and improving past them.
3. **Human-in-the-loop correction (DAgger)** — the model plays levels in coach mode; players take over when it fails; corrections are the most valuable data.
4. **Failures become levels** — where the model fails most, the game generates variations as "daily challenges", directing players to what the model needs.
5. **Sim-to-real** — domain randomization (lighting, textures, object sizes, physics); later validation on a real arm.

## 5. Key technical decisions

- **Use a real robot model** (e.g. SO-101 or Franka from MuJoCo Menagerie). In-game kinematics must match a real robot or the data is useless.
- **Log states and actions, not video.** Small uploads; episodes can be re-rendered later with any camera, lighting, or texture (free augmentation).
- **Physics accuracy > graphics** for the MVP. Later: MuJoCo Unity plugin for game-quality visuals on robotics-grade physics.
- **Dataset format:** LeRobot-compatible from day one.

## 6. Hardware and stack constraints

- Development machine: **MacBook M2** (Apple Silicon, macOS). No NVIDIA GPU.
- Isaac Sim / Isaac Lab do **not** run on macOS — do not use them.
- SteamVR does **not** run on macOS — Quest 3 integration goes through WebXR in the Quest browser, streaming poses to the Mac via WebSockets.
- **Simulation:** MuJoCo (native on macOS; WASM build for the browser).
- **Rendering (MVP):** MuJoCo WASM + three.js in the browser.
- **Policy:** SmolVLA via LeRobot; MLX ports (`mlx-smolvla`, `tokimoa/smolvla-mlx`) for fast inference on Apple Silicon (~160 ms per 50-step action chunk). Heavy training can run on a rented cloud GPU.
- **Phone control:**
  - Android Chrome: WebXR AR gives 6-DoF phone pose.
  - iPhone Safari: no WebXR AR (as far as known) → needs native ARKit app later.
  - MVP fallback for all phones: device orientation (tilt) for rotation + on-screen joystick for translation + Grip button.

## 7. MVP scope

One kitchen level, one robot arm, three care tasks, phone control, automatic success checks and scoring, episode logging, one trained policy that plays the level.

| Component | Difficulty | Estimate |
|---|---|---|
| MuJoCo scene (arm, table, cup, tray) | Easy–medium | 3–5 days |
| Browser rendering (MuJoCo WASM + three.js) | Medium | 1 week |
| Phone as controller | Hard | 1–2 weeks |
| Arm control (IK, gripper) | Medium | 3–5 days |
| Success checks + scoring | Easy | 2–3 days |
| Episode logging (LeRobot format) | Easy | 2 days |
| Train SmolVLA, run it in sim | Medium | 1 week |

Total: roughly 4–8 weeks part-time.

**Known hard parts:** phone tracking and latency/jitter (control feel), grasp physics stability (contact tuning), making it actually fun (test with friends early).

### Build order

1. Arm in a browser scene, keyboard-controlled.
2. Success check + score → playable game (first shareable demo).
3. Phone control.
4. Episode logging + training pipeline + model playing the level.

## 8. Inspiring research, projects and landscape

Each entry notes what Handover should learn or borrow from it.

### 8.1 Crowdsourced and simulated teleoperation (closest predecessors)

| Project | Who / when | What it showed | What we borrow | Link |
|---|---|---|---|---|
| DART + DexHub | MIT Improbable AI Lab (Pulkit Agrawal), 2024 | AR teleop in cloud simulation; first-time operators collected data 2.1× faster with less fatigue than real-world teleop; sim data gave more robust policies | Sim-first collection, central open data hub, user-study methodology. **Read first.** | https://arxiv.org/abs/2411.02214 |
| RoboTurk | Stanford, 2018 | Remote workers controlled simulated robots with a smartphone via a website; 2,200+ demos | Phone as motion controller, coordination-server architecture | https://arxiv.org/abs/1811.02790 |
| RoboTurk (real robots) | Stanford, 2019 | Extended crowdsourcing to physical arms with queueing and safety | How to scale to real robots later | https://arxiv.org/abs/1911.04052 |
| COBALT | 2026 | Cloud platform for teleoperating sim and real robots with phones, VR, keyboards, 3D mice; onboarding curriculum | Multi-device input support, onboarding/tutorial levels | https://arxiv.org/abs/2605.19138 |
| RoboCrowd | 2024 | Public-space ALOHA rig; studied incentive design for non-expert data collectors | Incentives and gamification design | https://arxiv.org/abs/2411.01915 |

### 8.2 Care robotics and assistive data

| Project | Who / when | What it showed | What we borrow | Link |
|---|---|---|---|---|
| OpenRoboCare | Cornell (Tapomayukh Bhattacharjee's lab), 2025 | Expert dataset: 21 occupational therapists, 15 caregiving tasks, 5 modalities | Task list and expert caregiving strategies; **potential collaborator** | https://arxiv.org/abs/2511.13707 |
| Longitudinal LfD with care providers | 2026 | Care providers teaching robots in homes over multiple visits; open dataset planned | Caregivers as teachers; realistic assistive task design | https://arxiv.org/abs/2608.25196 |
| ElderSim | KIST | Synthetic simulation platform for elderly daily activities | Sim environments for eldercare scenes | https://arxiv.org/abs/2010.14742 |
| ETRI-Activity3D | ETRI, Korea | Large RGB-D dataset of elderly daily activities from a robot's view | Which daily activities matter most | https://arxiv.org/abs/2003.01920 |

### 8.3 VLA models and training methods

| Project | What it is | Why it matters to us | Link |
|---|---|---|---|
| SmolVLA + LeRobot | Hugging Face's compact (~450M) VLA and open robot learning library | Our base policy and dataset format | https://github.com/huggingface/lerobot |
| mlx-smolvla | Native MLX inference, serving and preview fine-tuning on Apple Silicon | Run SmolVLA on the M2 without Torch | https://pypi.org/project/mlx-smolvla/ |
| smolvla-mlx | Independent MLX port; ~160 ms per 50-action chunk, 1.6 GB memory | Fast local inference benchmark | https://huggingface.co/tokimoa/smolvla-mlx |
| DREAM | 2026: generates VLA fine-tuning data from a captured workspace + language instruction, without human demos | Automatic data generation to complement player data | https://arxiv.org/abs/2608.29078 |
| VLM2VLA | Fine-tuning VLMs into VLAs with LoRA while avoiding catastrophic forgetting | Cheap fine-tuning recipe | https://arxiv.org/abs/2509.22195 |
| CRAFT | Force-aware curriculum fine-tuning for contact-rich manipulation | Gentleness/force metrics for care tasks | https://arxiv.org/abs/2602.12532 |

### 8.4 Simulation, benchmarks and tools

- **MuJoCo + MuJoCo Menagerie** (Google DeepMind) — physics engine and ready-made models of real robot arms. https://github.com/google-deepmind/mujoco_menagerie
- **BEHAVIOR** (Stanford) — household tasks defined as formal success conditions on sim state; model for our success predicates. https://behavior.stanford.edu
- **ALOHA** — low-cost bimanual teleop; de-facto standard for imitation-learning data collection.

### 8.5 Citizen science and games-with-a-purpose (gamification inspiration)

- **Foldit** — players solved protein-folding puzzles that beat algorithms; proof that games can produce real scientific value. https://fold.it
- **reCAPTCHA** — hidden known-answer items to measure contributor reliability; model for our gold levels and player reputation.

### 8.6 Companies and market signals

- **microagi** (Munich) — $55M seed ~10 months after founding (largest German seed round, July 2026). Atlas platform: data + deployment layer that fine-tunes existing robot models; "Shift" collects real household data through free cleaning services; claims ~$100M annual run rate. Validates "data is the bottleneck." https://siliconangle.com/2026/07/16/microagi-nabs-55m-teach-factory-robots-work/
- **Vectro Labs** — crowdsourced egocentric manipulation video via consumer smart glasses; competitor on the data side. https://www.bu.edu/innovate/profile/vectro-labs/
- **RobCo** (Munich) — TUM spin-off, industrial robotics unicorn (Oct 2026); local ecosystem signal. https://www.eu-startups.com/2026/10/munich-based-robco-becomes-a-robotics-unicorn-as-valuation-doubles-in-nine-months/

### 8.7 Our differentiation

Open, game-first (phone, Steam, Quest), care-focused, caregivers as teachers, and the trained model visible in the loop. The novelty is the combination, focus and community — not any single technology.

## 9. Next steps

1. Read the DART paper and OpenRoboCare.
2. Contact Bhattacharjee's lab (pitch: a platform that scales expert caregiving data).
3. Build MVP step 1 (kitchen scene + keyboard control).
4. Draft scoring formula and success predicates for the first three tasks.

## 10. Conventions for Claude

- Prefer simple, runnable steps; each build step should end in something playable or testable.
- Everything must run on the MacBook M2; flag anything needing a GPU or cloud.
- Keep data formats LeRobot-compatible.
- Physics and data correctness come before visual polish.
- Document success predicates and scoring weights for every new task.
- Commit as `Suavi Yildirim <345443090+suavi-yildirim@users.noreply.github.com>` (git config per clone), with no Claude co-author or session trailers.
- Any change to the scene, physics or scoring bumps `GAME_VERSION` in `web/src/recorder.js` and regenerates `tests/fixtures/` (pass the fixture path to each test). Episodes from different versions must not be mixed silently.
- Run all tests before pushing: `node tests/pick_place.mjs`, `tests/medication.mjs`, `tests/fall_hazard.mjs`, `tests/spacemouse.mjs`, `tests/upload.mjs`, `server/cf_worker/test.mjs`.

## 11. Current state and lessons learned (2026-10-25)

What has been built and decided since the plan above. The sections above remain the vision; this section is the ground truth for the code.

### Repo, licenses, running
- Repo: github.com/suavi-yildirim/handover (account renamed from syldrm3141; old URLs redirect). Local copy: `~/Documents_SY/05_Projects/Handover`.
- Code is Apache-2.0 (LICENSE, NOTICE lists MuJoCo, the SO-101 model, three.js and qrcode-generator). Recorded play data is CC BY 4.0; every episode carries `"license": "CC-BY-4.0"`. Copyright and attribution: "Suavi Yildirim and the Handover contributors".
- Run: `python3 tools/phone_server.py` from the repo root, then open http://localhost:8000 (phone page over HTTPS on :8443). Static web app, no build step; MuJoCo WASM 3.16.0 and three.js 0.186.1 are vendored in `web/vendor`.
- Dev machine is a MacBook M2 with **8 GB RAM**: fine for playing and sim, too slow for SmolVLA training.

### Robot and physics
- SO-101 from MuJoCo Menagerie; Suavi's real arm has **12 V STS3215 servos**. Arm forcerange 2.94 N·m (12 V stall torque), gripper capped at half (1.47 N·m, like LeRobot's 50% limit), jaw friction 0.4 (bare PLA). Edits are commented in `web/models/so101/so101.xml`. All robot-specific settings live in `web/src/robot.js`; recorded data is arm-specific, so lock the arm before large data collection.
- Kitchen: table top at z = 0, robot at the origin facing +x. Real-world object physics (porcelain cup 73 g, pill vial 20 g, glasses case 45 g, friction 0.4). Room in `web/models/kitchen/room.xml`; notes in `docs/kitchen_realism.md`.
- Start pose: gripper level (pitch 0) with the wrist camera on top (roll −90°). A level gripper only reaches the table about 28 cm or more from the shoulder axis, so objects sit 30–36 cm out. Best grasp: hover over the object, lower the open jaws around it, close. Horizontal slide-ins at table height are out of reach.
- IK: damped least squares on the grasp point (8 mm off `gripperframe` toward the moving jaw), solving position + pitch only; yaw follows the shoulder pan. Unreachable targets are refused (the gripper slides along the reach limit or stops; status bar shows "out of reach") instead of letting the arm fold into a surprising pose.

### Tasks and scoring (details in `docs/tasks.md`)
- Three kitchen tasks: `cup_on_tray`, `bring_medication` (hold the bottle in the hand zone 1.5 s), `tidy_fall_hazard` (glasses case from the table edge to the safe spot; the floor is out of reach).
- Score = data quality: speed, smoothness (RMS jerk), no bumps, plus a task metric (kept level / gentle approach / lifted not pushed) and no drops.
- Shared rules: knocking over (or off the table) any loose object that isn't the task's own fails the episode; the task object hitting another object counts as a bump. Lesson: score every object in the scene, not just the task object, or players get full points for collateral damage.
- Scripted demos score about 96 / 95 / 89; Suavi's own early runs scored 77–94.

### Episodes and training
- Browser records full sim state (qpos, qvel, ctrl in radians) on an exact 30 Hz sim-time grid, plus intent, events, tags; exported as `.jsonl.gz` (one episode per line). Log states, not video: cameras are rendered later.
- `training/` (training thread) converts raw episodes to a LeRobot v3.0 dataset: joints in degrees, gripper 0–100, 30 fps, 480×640 `front` (kitchen.xml) and `wrist_cam` (so101.xml) views. Schema in `docs/episode_schema.md`. Only successful, CC BY 4.0 episodes are kept by default; filter by `game_version` because layouts and arm strength changed (0.3.0 old layout, 0.4.x level start).
- Sharing (`docs/upload.md`): players opt in once (consent dialog: CC BY 4.0, contents, IP handling, contributor ID for removal); then each finished episode is POSTed to a free Cloudflare Worker (`server/cf_worker`) that validates it and commits it to the private HF dataset `suavi-yildirim/handover-episodes`. The HF token is a Worker secret only, never in the game. `UPLOAD_URL` in `web/src/upload.js` stays empty until the Worker is deployed. Sharing must stay opt-in (GDPR). Free plan CPU limit (~10 ms) means one episode per request.
- SmolVLA fine-tuning runs on a **free Colab T4** (`training/colab_train.ipynb`) because the 8 GB Mac is too slow; `policy_server.py` + `rollout.mjs` let the trained policy play the level in the game's own sim and scoring. π0.5 is planned as a later comparison.

### Controls
- Keyboard: WASD move, E/Q up/down, I/K tilt, J/L roll, Space grip, Shift precise, R reset, 1/2/3 task, C wrist camera inset, V four-view layout.
- Four-view mode (V): front (from behind the robot), top and side orthographic views with the room hidden, plus the orbit 3D view bottom-left; wrist inset hidden there. Helps judge height and reach; dataset cameras unchanged.
- Phone (iPhone 16 Pro): the phone is a controller for the game on the Mac via a WebSocket relay. First open runs a 6-move setup wizard (`web/phone/axes.html`) that learns the player's own turns and slides; calibration logs go to `.phone_logs/`. Limits: iOS Safari has no WebXR, so there is no true position tracking; slides come from integrated accelerometer and drift. Real 6-DoF needs a native ARKit app (or Quest 3 WebXR later).
- 3D mouse (SpaceMouse) works over WebHID in Chrome/Edge only, not Safari.

### Open risks
- Sim-to-real: gripper friction and grasp physics are tuned by estimate, not measured on the real arm; the gripper direction vs. real LeRobot calibration is unverified.
- Scene variety: one fixed kitchen layout. Policies need many scene/object variations (domain randomization, more levels) more than more demos of the same scene.
- Phone tracking drift and control feel; fun still needs playtests with other people.
- Full risk register and research ideas are kept as artifacts by the risk and research threads.
