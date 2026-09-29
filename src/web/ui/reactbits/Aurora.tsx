/**
 * Aurora — adapted from React Bits (reactbits.dev), MIT + Commons Clause.
 * Changes: renders only while `active`, pauses in hidden tabs, draws a single
 * static frame for reduced motion, precomputes color stops, caps pixel ratio.
 */
import { Color, Mesh, Program, Renderer, Triangle } from 'ogl';
import { useEffect, useRef } from 'react';

const VERT = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;
uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;
uniform float uLightMode;
out vec4 fragColor;

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

struct ColorStop { vec3 color; float position; };

#define COLOR_RAMP(colors, factor, finalColor) {              \\
  int index = 0;                                            \\
  for (int i = 0; i < 2; i++) {                             \\
    ColorStop currentColor = colors[i];                     \\
    bool isInBetween = currentColor.position <= factor;     \\
    index = int(mix(float(index), float(i), float(isInBetween))); \\
  }                                                         \\
  ColorStop currentColor = colors[index];                   \\
  ColorStop nextColor = colors[index + 1];                  \\
  float range = nextColor.position - currentColor.position; \\
  float lerpFactor = (factor - currentColor.position) / range; \\
  finalColor = mix(currentColor.color, nextColor.color, lerpFactor); \\
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  ColorStop colors[3];
  colors[0] = ColorStop(uColorStops[0], 0.0);
  colors[1] = ColorStop(uColorStops[1], 0.5);
  colors[2] = ColorStop(uColorStops[2], 1.0);
  vec3 rampColor;
  COLOR_RAMP(colors, uv.x, rampColor);
  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (uv.y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;
  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);
  vec3 auroraColor = intensity * rampColor;
  if (uLightMode > 0.5) {
    float energy = clamp(max(intensity, 0.0), 0.0, 1.0);
    float coverage = clamp(auroraAlpha * (0.55 + 0.45 * energy), 0.0, 0.86);
    vec3 chroma = pow(clamp(rampColor, 0.0, 1.0), vec3(1.2));
    float chromaPeak = max(chroma.r, max(chroma.g, chroma.b));
    chroma /= max(chromaPeak, 0.0001);
    float a = min(coverage * 1.08, 0.94);
    fragColor = vec4(chroma * a, a);
  } else {
    fragColor = vec4(auroraColor * auroraAlpha, auroraAlpha);
  }
}
`;

export interface AuroraProps {
  colorStops: [string, string, string];
  amplitude?: number;
  blend?: number;
  speed?: number;
  lightMode?: boolean;
  /** When false the render loop stops (e.g. during file transfers). */
  active?: boolean;
  /** Draw one still frame instead of animating. */
  still?: boolean;
}

export default function Aurora({ colorStops, amplitude = 1, blend = 0.5, speed = 1, lightMode = false, active = true, still = false }: AuroraProps) {
  const container = useRef<HTMLDivElement>(null);
  const settings = useRef({ amplitude, blend, speed, lightMode, active, still, stops: toRgb(colorStops), dirty: true });
  settings.current = { ...settings.current, amplitude, blend, speed, lightMode, active, still };
  const stopsKey = colorStops.join(',');

  useEffect(() => {
    settings.current.stops = toRgb(colorStops);
    settings.current.dirty = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopsKey]);

  useEffect(() => {
    const ctn = container.current;
    if (!ctn) return;
    let renderer: Renderer;
    try {
      renderer = new Renderer({ alpha: true, premultipliedAlpha: true, antialias: false, dpr: Math.min(window.devicePixelRatio, 1.5) });
    } catch {
      return; // WebGL unavailable: the CSS gradient fallback stays visible.
    }
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const geometry = new Triangle(gl);
    delete (geometry.attributes as Record<string, unknown>).uv;
    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAmplitude: { value: amplitude },
        uColorStops: { value: settings.current.stops },
        uResolution: { value: [ctn.offsetWidth, ctn.offsetHeight] },
        uBlend: { value: blend },
        uLightMode: { value: lightMode ? 1 : 0 },
      },
    });
    const mesh = new Mesh(gl, { geometry, program });
    ctn.appendChild(gl.canvas);
    gl.canvas.setAttribute('aria-hidden', 'true');

    const resize = () => {
      renderer.setSize(ctn.offsetWidth, ctn.offsetHeight);
      program.uniforms.uResolution!.value = [gl.drawingBufferWidth, gl.drawingBufferHeight];
      if (settings.current.still || !settings.current.active) draw(elapsed);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(ctn);

    let frame = 0;
    let elapsed = 20_000; // start mid-animation so the first frame already looks good
    let last: number | undefined;
    const draw = (time: number) => {
      const s = settings.current;
      program.uniforms.uTime!.value = time * 0.001 * s.speed;
      program.uniforms.uAmplitude!.value = s.amplitude;
      program.uniforms.uBlend!.value = s.blend;
      program.uniforms.uLightMode!.value = s.lightMode ? 1 : 0;
      program.uniforms.uColorStops!.value = s.stops;
      renderer.render({ scene: mesh });
    };
    const loop = (now: number) => {
      const s = settings.current;
      if (!s.active || s.still || document.hidden) {
        last = undefined;
        if (s.dirty && !document.hidden) {
          s.dirty = false;
          draw(elapsed);
        }
        frame = requestAnimationFrame(loop);
        return;
      }
      if (last !== undefined) elapsed += now - last;
      last = now;
      draw(elapsed);
      frame = requestAnimationFrame(loop);
    };
    resize();
    draw(elapsed);
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (gl.canvas.parentNode === ctn) ctn.removeChild(gl.canvas);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paused or still: redraw once after a visual change (theme switch, colors).
  useEffect(() => {
    settings.current.dirty = true;
  }, [lightMode, still, active, stopsKey]);

  return <div ref={container} className="aurora-container" />;
}

function toRgb(stops: readonly string[]): number[][] {
  return stops.map((hex) => {
    const c = new Color(hex);
    return [c.r, c.g, c.b];
  });
}
