"use client";

import { useEffect, useRef } from "react";

export function WaveformBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let W = 0;
    let H = 0;
    let dpr = 1;
    let raf = 0;
    let t = 0;

    function resize() {
      if (!canvas) return;
      dpr = window.devicePixelRatio || 1;
      W = canvas.offsetWidth;
      H = canvas.offsetHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx!.scale(dpr, dpr);
    }

    function draw() {
      if (!ctx) return;
      t += 0.004;

      ctx.clearRect(0, 0, W, H);

      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const bg = isDark ? "#08080A" : "#f8f8fa";
      const waveA: [number, number, number] = isDark ? [90, 140, 255] : [40, 100, 220];
      const waveB: [number, number, number] = isDark ? [255, 180, 55] : [200, 120, 20];
      const splice: [number, number, number] = isDark ? [180, 210, 255] : [60, 120, 255];
      const dotCol: [number, number, number] = isDark ? [255, 190, 60] : [200, 120, 20];
      const gridCol = isDark ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.05)";
      const labelCol = isDark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // Faint horizontal grid lines
      ctx.strokeStyle = gridCol;
      ctx.lineWidth = 0.5;
      const gridStep = H / 7;
      for (let y = gridStep; y < H; y += gridStep) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

      // Vertical tick marks along bottom
      ctx.strokeStyle = gridCol;
      for (let x = 0; x < W; x += 60) {
        ctx.beginPath();
        ctx.moveTo(x, H - 20);
        ctx.lineTo(x, H - 10);
        ctx.stroke();
      }

      const spliceX = W * 0.58;
      const midY = H * 0.5;

      type Harmonic = { freq: number; weight: number; speed: number; phase: number };

      function drawWave(
        originY: number,
        amplitude: number,
        phaseOffset: number,
        harmonics: Harmonic[],
        color: [number, number, number],
        filled: boolean
      ) {
        const steps = Math.ceil(W * 1.5);
        const pts: { x: number; y: number }[] = [];

        for (let i = 0; i <= steps; i++) {
          const x = (i / steps) * W;
          const tx = x / W;

          let y = 0;
          for (const h of harmonics) {
            y += Math.sin(tx * h.freq * Math.PI * 2 + t * h.speed + h.phase + phaseOffset) * h.weight;
          }

          const distFromSplice = Math.abs(x - spliceX) / W;
          const envelope = 0.15 + distFromSplice * 0.85;

          pts.push({ x, y: originY + y * amplitude * envelope });
        }

        if (filled) {
          const alpha = 0.18;
          const rgb = color.join(",");

          ctx.beginPath();
          ctx.moveTo(pts[0].x, originY);
          for (const p of pts) ctx.lineTo(p.x, p.y);
          ctx.lineTo(W, originY);
          ctx.closePath();
          ctx.fillStyle = `rgba(${rgb},${alpha})`;
          ctx.fill();

          ctx.beginPath();
          ctx.moveTo(pts[0].x, originY);
          for (const p of pts) ctx.lineTo(p.x, 2 * originY - p.y);
          ctx.lineTo(W, originY);
          ctx.closePath();
          ctx.fill();
        }

        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.strokeStyle = `rgba(${color.join(",")},0.7)`;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(pts[0].x, 2 * originY - pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, 2 * originY - pts[i].y);
        ctx.stroke();
      }

      const harmonicsA: Harmonic[] = [
        { freq: 3.1, weight: 0.55, speed: 0.9, phase: 0.0 },
        { freq: 7.3, weight: 0.25, speed: 1.6, phase: 1.2 },
        { freq: 13.7, weight: 0.12, speed: 2.1, phase: 2.4 },
        { freq: 1.9, weight: 0.18, speed: 0.5, phase: 0.8 },
      ];

      const harmonicsB: Harmonic[] = [
        { freq: 2.7, weight: 0.60, speed: 1.1, phase: 1.7 },
        { freq: 6.1, weight: 0.22, speed: 1.8, phase: 0.5 },
        { freq: 11.3, weight: 0.14, speed: 2.4, phase: 3.1 },
        { freq: 4.5, weight: 0.16, speed: 0.7, phase: 2.0 },
      ];

      drawWave(midY, H * 0.22, 0, harmonicsA, waveA, true);
      drawWave(midY, H * 0.22, 1.5, harmonicsB, waveB, true);
      drawWave(midY, H * 0.17, 0.3, harmonicsA, waveA, false);
      drawWave(midY, H * 0.17, 1.8, harmonicsB, waveB, false);

      // Splice vertical line with soft glow
      for (const [offset, alpha] of [[10, 0.025], [6, 0.055], [3, 0.11], [1, 0.22], [0, 0.75]] as [number, number][]) {
        for (const dx of offset > 0 ? [-offset, offset] : [0]) {
          ctx.beginPath();
          ctx.moveTo(spliceX + dx, 0);
          ctx.lineTo(spliceX + dx, H);
          ctx.strokeStyle = `rgba(${splice.join(",")},${alpha})`;
          ctx.lineWidth = offset > 0 ? 1 : 1.2;
          ctx.stroke();
        }
      }

      // Amber dot at splice × midY
      const dotR = 5;
      for (let r = 20; r > 0; r -= 2) {
        const a = ((1 - r / 22) ** 1.5) * 0.4;
        ctx.beginPath();
        ctx.arc(spliceX, midY, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${dotCol.join(",")},${a})`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(spliceX, midY, dotR, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${dotCol.join(",")})`;
      ctx.fill();

      // Minimal labels
      ctx.font = "11px monospace";
      ctx.fillStyle = labelCol;
      ctx.textAlign = "center";
      ctx.fillText("02:47", spliceX, H - 12);
      ctx.fillText("selected moment", spliceX, 18);
      ctx.textAlign = "left";
      ctx.fillText("·A", 8, midY - H * 0.12);
      ctx.fillText("·B", 8, midY + H * 0.14);

      raf = requestAnimationFrame(draw);
    }

    resize();

    const onResize = () => {
      cancelAnimationFrame(raf);
      resize();
      draw();
    };
    window.addEventListener("resize", onResize);
    draw();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 w-full h-full"
    />
  );
}
