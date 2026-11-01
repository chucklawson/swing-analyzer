# Swing Analyzer

A PWA for recording and analyzing golf swings on iPhone and iPad. Add it to your Home Screen from Safari for a full-screen experience without the browser chrome.

---

## Quick start

1. Open the app and tap **Create Videos** to record clips.
2. Tap **Start Camera** and point the phone at your swing area.
3. Draw a box around the **ball and club head region** by dragging on the video.
4. Tap **Calibrate** (optional but recommended) and hold still for 3 seconds.
5. Take your swing — the app saves a clip automatically.
6. Tap **Analyzer** from the home screen to load and review clips side by side.

---

## Create Videos — full reference

### Starting the camera

Tap **Start Camera**. The app will request camera and microphone permission. Grant both — the microphone is required for impact detection.

If permission is denied the screen shows step-by-step instructions for your browser (Safari, Chrome, Firefox, Edge on iOS, and desktop browsers).

While the camera is running you will see one of these status badges in the top-left corner of the video:

| Badge | Meaning |
|---|---|
| **Listening** (green) | Ready — waiting for a swing |
| **Recording** (red, pulsing) | Swing detected, capturing post-roll |
| **Review** (blue) | Playing back the just-saved clip |
| **Calibrating** (yellow, pulsing) | Measuring idle noise — hold still |

Tap the **camera-flip icon** (top-right of video, visible when Listening) to switch between front and rear cameras.

Tap **Stop** to turn the camera off.

---

### The ROI box (Region of Interest)

The white rectangle drawn over the video is the **Region of Interest**. Motion inside this box is what the app watches. Keeping it tight around the ball and club head gives the best results and avoids false triggers from background movement.

**Drawing a new box** — drag anywhere on the video to draw a new rectangle from scratch.

**Moving the box** — tap and drag inside the box to reposition it.

**Resizing the box** — drag any of the 8 white circular handles on the corners and edges.

**Reset box** — returns the box to the default centred position (60 % of the frame).

The box **flashes green** for a fraction of a second when a motion spike is detected inside it. This lets you see exactly what the detector is responding to before a clip is saved.

> **Tip:** Set up in portrait mode or landscape — the box stores its position in normalised coordinates so it always covers the same scene area regardless of orientation or screen size.

---

### How a clip is triggered

A clip saves when **both** of the following happen within the fusion window:

1. A **motion spike** is detected inside the ROI (the club/ball moves faster than the baseline).
2. An **audio impact** is detected by the microphone (a sharp transient much louder than background noise).

Motion must come at or just before the audio impact. This prevents false saves from:
- Clapping, loud music, or background noise (audio alone → rejected)
- Slow pans, shadows, someone walking past (motion alone → rejected)
- Follow-through after a shot (cooldown prevents a second save)

After a clip saves there is a **cooldown** (default 3 seconds) during which no new clips are saved.

---

### Controls

#### Audio sensitivity
Sets how much louder than background noise a sound must be to count as an impact.
- **Higher value** → only very sharp, loud impacts trigger (fewer false saves from noise)
- **Lower value** → lighter impacts also trigger (better for indoor putting)

Default: **2.5×** background.

#### Window (ms)
The maximum gap allowed between motion spike and audio impact. If the two signals arrive more than this far apart, the clip is not saved.
- **Wider window** → more forgiving of timing variation (helpful at slow swing speeds)
- **Narrower window** → stricter synchronisation required

Default: **400 ms**.

#### Record practice swings (motion only)
When checked, a clip also saves on motion alone — no impact sound required. Use this for putting practice or slow-motion drill work where there is no audible impact. Off by default.

#### Reset box
Returns the ROI to the default centre position.

---

### Calibration

Tap **Calibrate**, then hold the camera completely still for 3 seconds. The app measures:
- The idle motion level inside the ROI (camera shake, lighting flicker)
- The background audio level (room noise, wind)

After 3 seconds a result panel appears showing the measured values. Tap **Apply** to update the detection thresholds automatically, or dismiss to keep the current settings.

> **When to calibrate:** whenever you move to a new location, change lighting conditions, or find that the app is either missing swings or saving too many false clips. You do not need to calibrate every session — thresholds are saved and restored.

---

### Debug panel

Tap **Debug** to toggle the debug overlay on the video. It shows:

- **Motion bar** — current motion score inside the ROI (blue). The yellow line is where the detector's baseline × ratio threshold sits.
- **Audio bar** — current microphone level (green). The yellow line is the background × ratio threshold.
- **Last decisions** — a rolling log of recent fusion outcomes:
  - `FIRED swing` (green) — clip saved
  - `rejected: audio only` (red) — loud sound but no preceding motion
  - `rejected: motion only` (red) — movement but no impact sound
  - `rejected: cooldown` (orange) — too soon after the last clip
  - `rejected: ordering` (red) — audio arrived before motion
- **Calibration summary** — if calibration has been run, shows the idle motion and audio background values.

---

### Feedback buttons (during review)

While the just-saved clip plays back, two small buttons appear at the bottom of the video:

- **False trigger** — tap if the clip was saved when you did not swing. Records the event with surrounding trace data to local storage for later analysis.
- **Missed swing** — tap if a real swing was not captured. Helps track how often the detector misses.

These are stored locally (never sent anywhere) and can be exported with the trace.

---

### Save folder (desktop only)

On desktop Chrome/Edge, tap **Set save folder** to pick a folder on disk. Clips save silently there without a download dialog. On mobile, clips are always saved to the browser's private storage (OPFS) and can be exported from the Analyzer.

---

### Export trace

When **Trace** mode is enabled in the config (advanced), an **Export trace** button appears. Tapping it downloads a JSON file of timestamped motion scores and audio levels for the entire session. This can be replayed offline to tune thresholds without needing to swing again.

---

## Analyzer — full reference

Open from the home screen. Load one or two clips side by side to compare swings.

### Loading clips

Tap the video area or the load button to pick a clip from your device. Two video panels allow simultaneous comparison — useful for before/after or two different camera angles.

### Playback controls

| Control | Description |
|---|---|
| **Speed presets** (30 / 15 / 10 / 5 / 2 / 1 fps) | Slow the video down for frame-by-frame review |
| **Sync** | Lock both videos to the same playback position and speed |
| **Play / Pause** | Space bar on desktop; tap the video on mobile |

### Drawing tools

Tap the **pencil icon** to enter drawing mode. Drag on the video to draw reference lines. These lines stay on screen as the video plays and are useful for checking alignment angles, shaft plane, and follow-through path. The colour palette changes the line colour.

### Zoom

Pinch to zoom into the video (two fingers on mobile, scroll wheel on desktop). The video zooms into the pinch point. Tap the **zoom icon** or scroll out fully to reset.

### Pose detection (skeleton overlay)

Tap the **person icon** to run MediaPipe pose detection on the current frame. The skeleton with joint angles overlaid updates as the video plays. Joint angles (elbow, knee) are displayed numerically. The spine, shoulder, and hip lines are extended as reference guides.

### 3D skeleton

Tap the **cube icon** to open the 3D skeleton view. The detected pose is shown as a 3D figure that you can rotate (drag) to inspect from any angle.

---

## Settings that persist across sessions

| Setting | Where stored |
|---|---|
| ROI box position | localStorage (per device) |
| Audio sensitivity | localStorage |
| Fusion window | localStorage |
| Motion thresholds (from calibration) | localStorage |
| Motion-only mode | localStorage |
| Clip count per day | localStorage |

Clearing browser site data will reset all settings to defaults.

---

## Manual test checklist (iPad / iPhone)

Use this after an update to verify nothing regressed:

- [ ] Draw ROI in portrait, then rotate to landscape — box stays on same scene area
- [ ] Move box via body drag; resize via corner handles; Reset box returns to default
- [ ] Start camera in portrait, flip to front camera, flip back — clip saving still works
- [ ] Normal swing (club motion + impact sound) → clip saves, review plays
- [ ] Clap loudly without moving camera → no clip (audio-only rejection in debug log)
- [ ] Walk through ROI slowly without making noise → no clip (motion-only rejection)
- [ ] Swing twice rapidly → only one clip (second blocked by cooldown)
- [ ] Enable motion-only mode, move club without sound → clip saves
- [ ] Calibrate: hold still 3 s → result appears; Apply → thresholds update
- [ ] Debug panel: motion and audio bars animate in real time
- [ ] False-trigger and Missed-swing buttons appear during review and log to localStorage
- [ ] Clips load in Analyzer, playback speed controls work, sync locks both videos
- [ ] Pose overlay activates and tracks joints during playback
- [ ] Zoom in and out; full-screen mode
