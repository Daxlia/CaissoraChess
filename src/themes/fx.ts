// Effetti transitori e particelle ambientali. Nessuna allocazione per frame oltre ai punti già creati.
const glowCache = new Map<string, HTMLCanvasElement>();
/** Piccolo disco sfumato del colore dato, riusato per alone e particelle. */
export function glowSprite(color: string): HTMLCanvasElement {
  const hit = glowCache.get(color); if (hit) return hit;
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, color); gr.addColorStop(0.35, color); gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  // il gradiente sfuma verso il trasparente del colore, non verso il nero: si usa destination-in per la sagoma
  const m = document.createElement("canvas"); m.width = m.height = 64;
  const mg = m.getContext("2d")!; const mgr = mg.createRadialGradient(32, 32, 0, 32, 32, 32);
  mgr.addColorStop(0, "rgba(0,0,0,1)"); mgr.addColorStop(0.3, "rgba(0,0,0,0.85)"); mgr.addColorStop(1, "rgba(0,0,0,0)");
  mg.fillStyle = mgr; mg.fillRect(0, 0, 64, 64);
  g.globalCompositeOperation = "destination-in"; g.drawImage(m, 0, 0);
  glowCache.set(color, c);
  return c;
}

export interface Fx { start: number; dur: number; draw(g: CanvasRenderingContext2D, k: number): void }

export interface Particle { x: number; y: number; vx: number; vy: number; s: number; ph: number }

export class AmbientParticles {
  private p: Particle[] = [];
  private last = 0;
  constructor(readonly count: number, readonly dir: "up" | "down" | "drift") {
    for (let i = 0; i < count; i++) this.p.push({ x: Math.random(), y: Math.random(), vx: 0, vy: 0, s: 0.6 + Math.random() * 0.8, ph: Math.random() * 6.28 });
  }
  step(now: number, speed: number): void {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0; this.last = now;
    for (const q of this.p) {
      q.ph += dt * 1.3;
      const v = speed * q.s;
      if (this.dir === "up") { q.y -= v * dt; q.x += Math.sin(q.ph) * 0.02 * dt; }
      else if (this.dir === "down") { q.y += v * dt; q.x += Math.sin(q.ph) * 0.03 * dt; }
      else { q.x += v * dt * 0.7 + Math.sin(q.ph) * 0.02 * dt; q.y += v * dt * 0.5; }
      if (q.y < -0.05) q.y = 1.05; if (q.y > 1.05) q.y = -0.05; if (q.x > 1.05) q.x = -0.05; if (q.x < -0.05) q.x = 1.05;
    }
  }
  each(f: (p: Particle) => void): void { for (const q of this.p) f(q); }
}
