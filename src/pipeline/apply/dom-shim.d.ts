/**
 * Minimal DOM globals for code that runs inside page.evaluate() in the
 * browser page context. We intentionally don't add "DOM" to tsconfig lib
 * because it conflicts with the generated Workers runtime types.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare const document: any;

declare const CSS: { escape(value: string): string };

declare class DataTransfer {
  items: { add(file: any): void };
  files: any;
}

type HTMLElement = any;
type HTMLInputElement = any;
type HTMLSelectElement = any;
type Element = any;
