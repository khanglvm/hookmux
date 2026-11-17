// Engine version. The build replaces __HOOKMUX_VERSION__; source runs (tests) report "0.0.0-dev".

declare const __HOOKMUX_VERSION__: string | undefined;

export const VERSION: string = typeof __HOOKMUX_VERSION__ === "string" ? __HOOKMUX_VERSION__ : "0.0.0-dev";
