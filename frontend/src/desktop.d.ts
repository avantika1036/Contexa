export {};

declare global {
  interface Window {
    contexaDesktop?: {
      getStatus: () => Promise<{
        isDesktop: boolean;
        autoCaptureEnabled: boolean;
        captureActive: boolean;
        meetingTitle: string | null;
        lastCaptureError: string | null;
      }>;
      enableAutoCapture: () => Promise<{
        ok: boolean;
        message: string;
        status: {
          isDesktop: boolean;
          autoCaptureEnabled: boolean;
          captureActive: boolean;
          meetingTitle: string | null;
          lastCaptureError: string | null;
        };
      }>;
      onTranscript: (callback: (message: unknown) => void) => () => void;
      pauseAutoCapture: () => Promise<{
        ok: boolean;
        message: string;
        status: {
          isDesktop: boolean;
          autoCaptureEnabled: boolean;
          captureActive: boolean;
          meetingTitle: string | null;
          lastCaptureError: string | null;
        };
      }>;
    };
  }
}
