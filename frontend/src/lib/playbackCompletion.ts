/** Elapsed time and reaching the end during an internal seek are not completion. */
export function createPlaybackCompletion(onCompleted: () => void) {
  let reported = false;
  return (state: string, hasDisplayedContent: boolean, seeking: boolean) => {
    if (!reported && !seeking && hasDisplayedContent && state === "finished") {
      reported = true;
      onCompleted();
    }
  };
}
