/** An initial seek can land on a later first keyframe. Prime around the element's effective playhead. */
export function hasStartupBuffer(element: Pick<HTMLMediaElement, 'buffered' | 'currentTime'>, duration: number): boolean {
    const { buffered, currentTime } = element;
    for (let i = 0; i < buffered.length; i++) {
        if (buffered.start(i) <= currentTime + 0.1 && buffered.end(i) >= Math.min(duration - 0.05, currentTime + 2)) return true;
    }
    return false;
}

type TrackBuffer = Pick<SourceBuffer, 'buffered'>;

/** A muxer can hold packets until the next keyframe. Only pause the reader once both active tracks have submitted enough media. */
export function canWaitForPlayback(readThrough: number, position: number, video: TrackBuffer | null, audio: TrackBuffer | null): boolean {
    if (readThrough <= position + 4.5) return false;
    const hasReserve = (track: TrackBuffer | null): boolean => {
        if (!track) return true;
        const ranges = track.buffered;
        return ranges.length > 0 && ranges.end(ranges.length - 1) >= position + 2;
    };
    return hasReserve(video) && hasReserve(audio);
}
