interface ScreensaverBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export interface ComposerScreensaverOptions {
  /** Returns true when the screensaver may play (e.g. a real session is open). */
  isEnabled: () => boolean;
}

/**
 * Idle "screensaver" physics overlay for the composer.
 *
 * When the prompt has been left empty and untouched for IDLE_MS, a canvas fills
 * the composer and animates balls bouncing off the composer border. A ball–ball
 * collision splits the two colliding balls plus a newly spawned third ball into
 * a pinwheel of three directions exactly 120 degrees apart, so the field grows
 * over time (up to MAX_BALLS). Once it reaches the ceiling creation stops but
 * collisions continue, and a RESET_S countdown restarts the field at
 * START_BALLS with fresh random velocities and positions. Any interaction with
 * the composer hides the overlay and restarts the idle timer. Balls use the
 * prompt's text color.
 *
 * Collision detection uses a spatial hash grid (broad phase) so each pair is
 * only checked against balls in the 3x3 block of cells around it, keeping it
 * cheap at MAX_BALLS instead of the brute-force O(n^2) pair scan.
 */
export class ComposerScreensaver {
  private static readonly IDLE_MS = 15_000;
  private static readonly MAX_BALLS = 1_000;
  private static readonly RESET_S = 5;
  private static readonly START_BALLS = 2;
  private static readonly MIN_BALL_RADIUS = 2;
  private static readonly MAX_BALL_RADIUS = 3;
  private static readonly MIN_SPEED = 45;
  private static readonly MAX_SPEED = 110;
  private static readonly MAX_SPAWNS_PER_FRAME = 4;
  // The spatial hash cell size must be at least the largest contact distance
  // (MAX_BALL_RADIUS * 2) so colliding balls always sit in the same or adjacent
  // cells; 8px keeps the neighborhood scan to 3x3 cells.
  private static readonly CELL_SIZE = 8;

  private readonly composer: HTMLFormElement;
  private readonly prompt: HTMLTextAreaElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly isEnabled: () => boolean;
  private readonly resizeObserver: ResizeObserver;
  private readonly activityEvents: Array<keyof HTMLElementEventMap> = [
    "keydown", "input", "focus", "pointerdown", "paste", "drop",
  ];

  private balls: ScreensaverBall[] = [];
  private color = "#ffd266";
  private active = false;
  private frame = 0;
  private lastTick = 0;
  private width = 0;
  private height = 0;
  private spawnBudget = 0;
  private waitingReset = false;
  private resetCountdown = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(composer: HTMLFormElement, prompt: HTMLTextAreaElement, options: ComposerScreensaverOptions) {
    this.composer = composer;
    this.prompt = prompt;
    const canvas = composer.querySelector<HTMLCanvasElement>("canvas.composer-screensaver");
    if (!canvas) throw new Error("Missing canvas.composer-screensaver");
    this.canvas = canvas;
    this.context = canvas.getContext("2d")!;
    this.isEnabled = options.isEnabled;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(composer);
    window.addEventListener("resize", this.onWindowResize);
    for (const type of this.activityEvents) composer.addEventListener(type, this.onActivity, true);
    this.resize();
  }

  restartIdle(): void {
    this.stop();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.tryStart(), ComposerScreensaver.IDLE_MS);
  }

  private onActivity = (): void => {
    this.restartIdle();
  };

  private onWindowResize = (): void => {
    this.resize();
  };

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.width = this.composer.clientWidth;
    this.height = this.composer.clientHeight;
    this.canvas.width = Math.max(1, Math.round(this.width * dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * dpr));
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private tryStart(): void {
    if (!this.isEnabled()) return;
    if (this.prompt.disabled) return;
    if (this.prompt.value.trim()) return; // Never cover the field when it has text.
    if (this.width <= 0 || this.height <= 0) return;
    this.start();
  }

  private start(): void {
    this.color = getComputedStyle(this.prompt).color;
    this.resize();
    if (this.active) return;
    this.active = true;
    this.composer.classList.add("screensaver");
    this.resetField(ComposerScreensaver.START_BALLS);
    this.lastTick = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this.frame);
    this.composer.classList.remove("screensaver");
  }

  private resetField(count: number): void {
    this.balls = [];
    for (let index = 0; index < count; index++) this.balls.push(this.spawnRandomBall());
    this.waitingReset = false;
    this.resetCountdown = 0;
  }

  private ballSpeed(): number {
    return ComposerScreensaver.MIN_SPEED
      + Math.random() * (ComposerScreensaver.MAX_SPEED - ComposerScreensaver.MIN_SPEED);
  }

  private newBall(x: number, y: number, angle: number, speed: number): ScreensaverBall {
    const r = ComposerScreensaver.MIN_BALL_RADIUS
      + Math.random() * (ComposerScreensaver.MAX_BALL_RADIUS - ComposerScreensaver.MIN_BALL_RADIUS);
    return { x, y, r, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
  }

  private spawnRandomBall(): ScreensaverBall {
    const angle = Math.random() * Math.PI * 2;
    const ball = this.newBall(0, 0, angle, this.ballSpeed());
    ball.x = ball.r + Math.random() * Math.max(0, this.width - ball.r * 2);
    ball.y = ball.r + Math.random() * Math.max(0, this.height - ball.r * 2);
    return ball;
  }

  private spawnBallAt(x: number, y: number, angle: number): ScreensaverBall | undefined {
    if (this.balls.length >= ComposerScreensaver.MAX_BALLS) return undefined;
    if (this.spawnBudget <= 0) return undefined;
    this.spawnBudget--;
    const ball = this.newBall(x, y, angle, this.ballSpeed());
    this.balls.push(ball);
    return ball;
  }

  private tick = (timestamp: number): void => {
    if (!this.active) return;
    const dt = Math.min(0.05, Math.max(0, (timestamp - this.lastTick) / 1_000));
    this.lastTick = timestamp;
    this.update(dt);
    this.draw();
    this.frame = requestAnimationFrame(this.tick);
  };

  private update(dt: number): void {
    const width = this.width;
    const height = this.height;
    const balls = this.balls;
    for (const ball of balls) {
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      if (ball.x - ball.r < 0) {
        ball.x = ball.r;
        ball.vx = Math.abs(ball.vx);
      } else if (ball.x + ball.r > width) {
        ball.x = width - ball.r;
        ball.vx = -Math.abs(ball.vx);
      }
      if (ball.y - ball.r < 0) {
        ball.y = ball.r;
        ball.vy = Math.abs(ball.vy);
      } else if (ball.y + ball.r > height) {
        ball.y = height - ball.r;
        ball.vy = -Math.abs(ball.vy);
      }
    }
    this.collide();
    if (balls.length >= ComposerScreensaver.MAX_BALLS && !this.waitingReset) {
      this.waitingReset = true;
      this.resetCountdown = ComposerScreensaver.RESET_S;
    }
    if (this.waitingReset) {
      this.resetCountdown -= dt;
      if (this.resetCountdown <= 0) this.resetField(ComposerScreensaver.START_BALLS);
    }
  }

  /** Broad-phase spatial hash: only test pairs within the 3x3 cell neighborhood. */
  private collide(): void {
    const balls = this.balls;
    const count = balls.length;
    if (count < 2) return;
    const cellSize = ComposerScreensaver.CELL_SIZE;
    const cols = Math.max(1, Math.ceil(this.width / cellSize));
    const rows = Math.max(1, Math.ceil(this.height / cellSize));
    const grid = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const ball = balls[i]!;
      const cx = Math.floor(ball.x / cellSize);
      const cy = Math.floor(ball.y / cellSize);
      const key = cy * cols + cx;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(i);
    }
    this.spawnBudget = ComposerScreensaver.MAX_SPAWNS_PER_FRAME;
    for (let i = 0; i < count; i++) {
      const a = balls[i]!;
      const ax = Math.floor(a.x / cellSize);
      const ay = Math.floor(a.y / cellSize);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = ax + ox;
          const cy = ay + oy;
          if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
          const bucket = grid.get(cy * cols + cx);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue; // Each pair is tested once.
            this.resolveCollision(a, balls[j]!);
          }
        }
      }
    }
  }

  private resolveCollision(a: ScreensaverBall, b: ScreensaverBall): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const combinedRadius = a.r + b.r;
    const distSq = dx * dx + dy * dy;
    if (distSq >= combinedRadius * combinedRadius || distSq === 0) return;
    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const ny = dy / dist;
    // Only act when the pair is actually approaching; once resolved and
    // flying apart they must not be re-processed or they would re-collide.
    if ((a.vx - b.vx) * nx + (a.vy - b.vy) * ny <= 0) return;
    // Splits the two colliding balls plus a spawned third ball into a pinwheel
    // of three directions exactly 120 degrees apart (centered on the outward
    // normal so the collided pair genuinely separates), while the trio flies
    // symmetrically away from the impact point.
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const baseAngle = Math.atan2(ny, nx);
    const outAngle = baseAngle + Math.PI;
    const speed = this.ballSpeed();
    const aAngle = outAngle;                  // a lies on -n and flies out along -n
    const bAngle = outAngle + (2 * Math.PI / 3);
    const thirdAngle = outAngle - (2 * Math.PI / 3);
    a.vx = Math.cos(aAngle) * speed;
    a.vy = Math.sin(aAngle) * speed;
    b.vx = Math.cos(bAngle) * speed;
    b.vy = Math.sin(bAngle) * speed;
    const third = this.spawnBallAt(cx, cy, thirdAngle);
    if (third) {
      third.vx = Math.cos(thirdAngle) * speed;
      third.vy = Math.sin(thirdAngle) * speed;
      third.x = cx + Math.cos(thirdAngle) * third.r;
      third.y = cy + Math.sin(thirdAngle) * third.r;
    }
    // Push the two colliding balls onto their rays so they start separated
    // and moving away from the impact point.
    a.x = cx + Math.cos(aAngle) * a.r;
    a.y = cy + Math.sin(aAngle) * a.r;
    b.x = cx + Math.cos(bAngle) * b.r;
    b.y = cy + Math.sin(bAngle) * b.r;
  }

  private draw(): void {
    const context = this.context;
    context.clearRect(0, 0, this.width, this.height);
    context.fillStyle = this.color;
    // Render balls as crisp integer-aligned pixel squares: no canvas path
    // anti-aliasing, so edges stay sharp instead of blurry. A 2-3px radius ball
    // reads as a ~4-6px felt pixel against the terminal surface.
    for (const ball of this.balls) {
      const x = Math.floor(ball.x - ball.r);
      const y = Math.floor(ball.y - ball.r);
      const size = Math.max(1, Math.ceil(ball.r * 2));
      context.fillRect(x, y, size, size);
    }
  }
}
