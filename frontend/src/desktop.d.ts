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
      endAutoCapturedMeeting: (meetingId: string) => Promise<{
        ok: boolean;
        stopped?: boolean;
        message: string;
        status: {
          isDesktop: boolean;
          autoCaptureEnabled: boolean;
          captureActive: boolean;
          meetingTitle: string | null;
          lastCaptureError: string | null;
        };
      }>;
      onTranscript: (callback: (payload: unknown) => void) => () => void;
    };
  }
}
