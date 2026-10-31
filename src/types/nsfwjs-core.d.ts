// Types for `nsfwjs/core`, the trimmed nsfwjs entry point (no bundled models).
//
// Hand-written on purpose. The package ships its own `.d.ts`, and since the
// move to `moduleResolution: "bundler"` (TypeScript 6) `nsfwjs/core` resolves
// to it (`dist/esm/core.d.ts`). This ambient declaration still takes
// precedence over the resolved file, and it has to: the shipped declarations
// import `@tensorflow/tfjs`, the meta package we deliberately do not install
// (see src/moderation/tfjs.ts) — an error only `skipLibCheck` hides, leaving
// the tfjs-derived types unresolved.
//
// Narrowed to what src/moderation/imagePrecheck.ts uses: load a self-hosted
// graph model, classify one canvas. Keep in sync with the nsfwjs version in
// package.json if that surface grows.
declare module 'nsfwjs/core' {
  export type PredictionType = {
    className: 'Drawing' | 'Hentai' | 'Neutral' | 'Porn' | 'Sexy';
    probability: number;
  };

  export interface NSFWJSOptions {
    /** Input edge length the model expects. MobileNetV2 variants: 224. */
    size?: number;
    /** `'graph'` selects `tf.loadGraphModel`; anything else needs tfjs-layers. */
    type?: string;
  }

  export class NSFWJS {
    classify(
      img: ImageData | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
      topk?: number,
    ): Promise<PredictionType[]>;
    dispose(): void;
  }

  export function load(modelUrl: string, options?: NSFWJSOptions): Promise<NSFWJS>;
}
