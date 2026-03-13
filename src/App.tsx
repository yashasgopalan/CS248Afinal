import { Canvas, useThree } from "@react-three/fiber";
import { SplatMesh } from "./components/spark/SplatMesh";
import { SparkRenderer } from "./components/spark/SparkRenderer";
import { CameraControls } from "@react-three/drei";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";
import type { SplatMesh as SparkSplatMesh } from "@sparkjsdev/spark";

// ── Hyperparameters ───────────────────────────────────────────────────
const BETA_INIT = 0.003;
const BETA_MAX = 0.2;
const SNOW_COUNT_MAX = 15000;
const SNOW_COUNT_INIT = 6000;
const SNOW_SEED = 42;
const SNOW_COLOR = [0.95, 0.95, 0.95] as const;
const SNOW_COLOR_JITTER = 0.02;
const SNOW_ALPHA_MIN = 0.7;
const SNOW_ALPHA_MAX = 0.9;
const SNOW_SCALE_MIN = 0.01;
const SNOW_SCALE_MAX = 0.035;
const SNOW_ELONGATION = 0.85;
const SNOW_BOX_XZ = 10;
const SNOW_BOX_Y_ABOVE = 10;
const SNOW_BOX_Y_BELOW = 5;
const SNOW_FALL_SPEED = 1.5;
const SNOW_DRIFT_SPEED = 1.5;
const SNOW_DRIFT_FREQ = 0.25;
const FOG_COLOR = new THREE.Vector3(1, 1, 1);

function makeRNG(seed: number) {
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function App() {
  const [beta, setBeta] = useState(BETA_INIT);
  const [snowCount, setSnowCount] = useState(SNOW_COUNT_INIT);

  return (
    <div className="relative flex h-screen w-screen">
      <Canvas gl={{ antialias: false }}>
        <Scene beta={beta} snowCount={snowCount} />
      </Canvas>
      {/* Sliders overlay */}
      <div
        className="pointer-events-auto fixed left-3 top-3 z-10 min-w-[270px] rounded-xl bg-black/55 px-3.5 py-2.5 font-sans text-white"
        style={{ fontFamily: "system-ui, sans-serif" }}
      >
        <label className="mb-1.5 block">
          fog density (beta):
          <input
            type="range"
            min={0}
            max={BETA_MAX}
            step={BETA_MAX / 200}
            value={beta}
            onChange={(e) => setBeta(parseFloat(e.target.value))}
            className="ml-2 align-middle"
            style={{ width: 220 }}
          />{" "}
          <span>{beta.toFixed(4)}</span>
        </label>
        <label className="mb-1.5 block">
          snowfall density:
          <input
            type="range"
            min={0}
            max={SNOW_COUNT_MAX}
            step={100}
            value={snowCount}
            onChange={(e) =>
              setSnowCount(Math.round(parseFloat(e.target.value)))
            }
            className="ml-2 align-middle"
            style={{ width: 220 }}
          />{" "}
          <span>{snowCount}</span> flakes
        </label>
        <div className="mt-2 border-t border-white/20 pt-2 text-[0.8em] opacity-80">
          <div className="mb-0.5 font-medium">
            Transmittance T(d) = exp(−βd)
          </div>
          <div className="mb-0.5">
            T(5) = <span>{Math.exp(-beta * 5).toFixed(3)}</span>
            {" · "}
            T(20) = <span>{Math.exp(-beta * 20).toFixed(3)}</span>
          </div>
          <div className="mb-0.5 font-medium">
            Absorption = 1 − T(d)
          </div>
          <div>
            1−T(5) = <span>{(1 - Math.exp(-beta * 5)).toFixed(3)}</span>
            {" · "}
            1−T(20) = <span>{(1 - Math.exp(-beta * 20)).toFixed(3)}</span>
          </div>
        </div>
        <div className="mt-1.5 text-[0.82em] opacity-75">
          WASD / arrows · mouse to look
        </div>
      </div>
    </div>
  );
}

type SceneProps = {
  beta: number;
  snowCount: number;
};

const Scene = ({ beta, snowCount }: SceneProps) => {
  const renderer = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  const meshRef = useRef<SparkSplatMesh>(null);
  const snowMeshRef = useRef<SparkSplatMesh>(null);
  const snowCountRef = useRef(snowCount);
  snowCountRef.current = snowCount;

  // Force fog generators to re-run when beta changes (otherwise they only run on camera move)
  useEffect(() => {
    meshRef.current?.updateVersion();
    snowMeshRef.current?.updateVersion();
  }, [beta]);

  // Fog dyno uniforms (shared by scene and snow)
  const fogUniforms = useMemo(() => {
    const uBeta = dyno.dynoFloat(BETA_INIT);
    const uFogColor = dyno.dynoVec3(FOG_COLOR.clone());
    return { uBeta, uFogColor };
  }, []);

  // Sync beta to dyno uniform
  fogUniforms.uBeta.value = beta;

  const makeFogModifier = useCallback(
    (mesh: SparkSplatMesh) => {
      mesh.enableViewToWorld = true;
      const camPos = mesh.context.viewToWorld.translate;
      const { uBeta, uFogColor } = fogUniforms;
      return dyno.dynoBlock(
        { gsplat: dyno.Gsplat },
        { gsplat: dyno.Gsplat },
        ({ gsplat }) => {
          if (!gsplat) return { gsplat };
          const { center, rgb, opacity } = dyno.splitGsplat(gsplat).outputs;
          const dist = dyno.distance(center, camPos);
          const T = dyno.exp(dyno.neg(dyno.mul(uBeta, dist)));
          const one = dyno.dynoConst("float", 1.0);
          // absorption = (1 - T)
          const absorption = dyno.sub(one, T);
          // color: C_fog + C_splat = (1-T)·c_fog + T·c_splat
          const newRgb = dyno.add(
            dyno.mul(uFogColor, absorption),
            dyno.mul(rgb, T),
          );
          // alpha: same idea but respecting existing opacity
          const newAlpha = dyno.sub(
            one,
            dyno.mul(T, dyno.sub(one, opacity)),
          );
          return {
            gsplat: dyno.combineGsplat({
              gsplat,
              rgb: newRgb,
              opacity: newAlpha,
            }),
          };
        },
      );
    },
    [fogUniforms],
  );

  // Pre-compute snow data (once)
  const snowData = useMemo(() => {
    const rng = makeRNG(SNOW_SEED);
    const snowPos = new Float32Array(SNOW_COUNT_MAX * 3);
    const snowPhase = new Float32Array(SNOW_COUNT_MAX);
    const snowScl = new Float32Array(SNOW_COUNT_MAX * 3);
    const snowQuat = new Float32Array(SNOW_COUNT_MAX * 4);
    const snowOpac = new Float32Array(SNOW_COUNT_MAX);
    const snowColR = new Float32Array(SNOW_COUNT_MAX);
    const snowColG = new Float32Array(SNOW_COUNT_MAX);
    const snowColB = new Float32Array(SNOW_COUNT_MAX);
    const cx0 = 0,
      cy0 = 0,
      cz0 = 0;
    for (let i = 0; i < SNOW_COUNT_MAX; i++) {
      snowPos[i * 3 + 0] =
        cx0 + (rng() - 0.5) * 2 * SNOW_BOX_XZ;
      snowPos[i * 3 + 1] =
        cy0 -
        SNOW_BOX_Y_BELOW +
        rng() * (SNOW_BOX_Y_ABOVE + SNOW_BOX_Y_BELOW);
      snowPos[i * 3 + 2] =
        cz0 + (rng() - 0.5) * 2 * SNOW_BOX_XZ;
      snowPhase[i] = rng() * Math.PI * 2;
      const s =
        SNOW_SCALE_MIN + rng() * (SNOW_SCALE_MAX - SNOW_SCALE_MIN);
      snowScl[i * 3 + 0] = s;
      snowScl[i * 3 + 1] = s;
      snowScl[i * 3 + 2] = s * SNOW_ELONGATION;
      const u1 = rng();
      const u2 = rng() * Math.PI * 2;
      const u3 = rng() * Math.PI * 2;
      const sq1 = Math.sqrt(1 - u1);
      const squ1 = Math.sqrt(u1);
      snowQuat[i * 4 + 0] = sq1 * Math.sin(u2);
      snowQuat[i * 4 + 1] = sq1 * Math.cos(u2);
      snowQuat[i * 4 + 2] = squ1 * Math.sin(u3);
      snowQuat[i * 4 + 3] = squ1 * Math.cos(u3);
      snowOpac[i] =
        SNOW_ALPHA_MIN + rng() * (SNOW_ALPHA_MAX - SNOW_ALPHA_MIN);
      snowColR[i] = Math.min(
        1,
        Math.max(
          0,
          SNOW_COLOR[0] + (rng() - 0.5) * 2 * SNOW_COLOR_JITTER,
        ),
      );
      snowColG[i] = Math.min(
        1,
        Math.max(
          0,
          SNOW_COLOR[1] + (rng() - 0.5) * 2 * SNOW_COLOR_JITTER,
        ),
      );
      snowColB[i] = Math.min(
        1,
        Math.max(
          0,
          SNOW_COLOR[2] + (rng() - 0.5) * 2 * SNOW_COLOR_JITTER,
        ),
      );
    }
    return {
      snowPos,
      snowPhase,
      snowScl,
      snowQuat,
      snowOpac,
      snowColR,
      snowColG,
      snowColB,
    };
  }, []);

  const sparkRendererArgs = useMemo(() => ({ renderer }), [renderer]);

  const splatMeshArgs = useMemo(
    () =>
      ({
        url: "/assets/splats/project-modern-house-with-lush-landscaping.spz",
        lod: true,
        onLoad: (mesh: SparkSplatMesh) => {
          mesh.worldModifier = makeFogModifier(mesh);
          mesh.updateGenerator();
        },
      }) as const,
    [makeFogModifier],
  );

  const snowMeshArgs = useMemo(() => {
    const _sc = new THREE.Vector3();
    const _ss = new THREE.Vector3();
    const _sq = new THREE.Quaternion();
    const _scol = new THREE.Color();
    const {
      snowPos,
      snowPhase,
      snowScl,
      snowQuat,
      snowOpac,
      snowColR,
      snowColG,
      snowColB,
    } = snowData;

    return {
      maxSplats: SNOW_COUNT_MAX,
      constructSplats: (ps: { ensureSplats: (n: number) => void; pushSplat: (c: THREE.Vector3, s: THREE.Vector3, q: THREE.Quaternion, o: number, col: THREE.Color) => void }) => {
        ps.ensureSplats(SNOW_COUNT_MAX);
        for (let i = 0; i < SNOW_COUNT_MAX; i++) {
          _sc.set(snowPos[i * 3], snowPos[i * 3 + 1], snowPos[i * 3 + 2]);
          _ss.set(snowScl[i * 3], snowScl[i * 3 + 1], snowScl[i * 3 + 2]);
          _sq.set(
            snowQuat[i * 4],
            snowQuat[i * 4 + 1],
            snowQuat[i * 4 + 2],
            snowQuat[i * 4 + 3],
          );
          _scol.setRGB(snowColR[i], snowColG[i], snowColB[i]);
          ps.pushSplat(_sc, _ss, _sq, snowOpac[i], _scol);
        }
      },
      onLoad: (mesh: SparkSplatMesh) => {
        mesh.worldModifier = makeFogModifier(mesh);
        mesh.updateGenerator();
      },
      onFrame: ({
        mesh,
        time,
        deltaTime,
      }: {
        mesh: SparkSplatMesh;
        time: number;
        deltaTime: number;
      }) => {
        const activeSnowCount = snowCountRef.current;
        if (activeSnowCount === 0) {
          if (mesh.numSplats !== 0) {
            mesh.packedSplats.numSplats = 0;
            mesh.numSplats = 0;
            mesh.packedSplats.needsUpdate = true;
            mesh.updateVersion();
          }
          return;
        }
        const dt = Math.min(deltaTime, 0.05);
        const cx = camera.position.x;
        const cy = camera.position.y;
        const cz = camera.position.z;
        const yMin = cy - SNOW_BOX_Y_BELOW;
        const yMax = cy + SNOW_BOX_Y_ABOVE;
        const xMin = cx - SNOW_BOX_XZ;
        const xMax = cx + SNOW_BOX_XZ;
        const zMin = cz - SNOW_BOX_XZ;
        const zMax = cz + SNOW_BOX_XZ;

        for (let i = 0; i < activeSnowCount; i++) {
          let px = snowPos[i * 3 + 0];
          let py = snowPos[i * 3 + 1];
          let pz = snowPos[i * 3 + 2];
          py -= SNOW_FALL_SPEED * dt;
          const ph = snowPhase[i];
          px +=
            Math.sin(time * SNOW_DRIFT_FREQ + ph) * SNOW_DRIFT_SPEED * dt;
          pz +=
            Math.cos(time * SNOW_DRIFT_FREQ + ph * 1.37) *
            SNOW_DRIFT_SPEED *
            dt;
          if (
            py < yMin ||
            px < xMin ||
            px > xMax ||
            pz < zMin ||
            pz > zMax
          ) {
            py = yMax;
            px = cx + (Math.random() - 0.5) * 2 * SNOW_BOX_XZ;
            pz = cz + (Math.random() - 0.5) * 2 * SNOW_BOX_XZ;
          }
          snowPos[i * 3 + 0] = px;
          snowPos[i * 3 + 1] = py;
          snowPos[i * 3 + 2] = pz;
          _sc.set(px, py, pz);
          _ss.set(snowScl[i * 3], snowScl[i * 3 + 1], snowScl[i * 3 + 2]);
          _sq.set(
            snowQuat[i * 4],
            snowQuat[i * 4 + 1],
            snowQuat[i * 4 + 2],
            snowQuat[i * 4 + 3],
          );
          _scol.setRGB(snowColR[i], snowColG[i], snowColB[i]);
          mesh.packedSplats.setSplat(i, _sc, _ss, _sq, snowOpac[i], _scol);
        }
        mesh.packedSplats.numSplats = activeSnowCount;
        mesh.numSplats = activeSnowCount;
        mesh.packedSplats.needsUpdate = true;
        mesh.updateVersion();
      },
    } as const;
  }, [snowData, makeFogModifier, camera]);

  useEffect(() => {
    scene.background = new THREE.Color(
      FOG_COLOR.x,
      FOG_COLOR.y,
      FOG_COLOR.z,
    );
  }, [scene]);

  return (
    <>
      <CameraControls />
      <SparkRenderer args={[sparkRendererArgs]}>
        <group rotation={[0, 0, 0]}>
          <SplatMesh ref={meshRef} args={[splatMeshArgs]} />
        </group>
        <SplatMesh ref={snowMeshRef} args={[snowMeshArgs]} />
      </SparkRenderer>
    </>
  );
};

export default App;
