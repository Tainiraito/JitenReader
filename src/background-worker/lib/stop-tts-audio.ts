import { runtime } from '@shared/extension/runtime';

export const stopTtsAudio = async (): Promise<void> => {
  const contexts = await runtime.getContexts({
    contextTypes: [runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (!contexts.length) {
    return;
  }

  try {
    await runtime.sendMessage({ type: 'stopTtsAudio' });
  } catch (error) {
    // The offscreen document may close between the context check and delivery.
    if (!(error instanceof Error) || !error.message.includes('Receiving end does not exist')) {
      throw error;
    }
  }
};
