// Ambient declarations shared by the main process, preload and renderer builds.

declare module '*?raw' {
  const content: string
  export default content
}

declare module '*.css'
