function covers(ranges: TimeRanges, position: number, end: number): boolean {
    for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= position + 0.1 && ranges.end(i) >= end) return true;
    }
    return false;
}

/** An initial seek can land on a later first keyframe. Prime around the element's effective playhead. */
export function hasStartupBuffer(element: Pick<HTMLMediaElement, 'buffered' | 'currentTime'>, duration: number): boolean {
    return covers(element.buffered, element.currentTime, Math.min(duration - 0.05, element.currentTime + 2));
}

type TrackBuffer = Pick<SourceBuffer, 'buffered'>;

/** A muxer can hold packets until the next keyframe. Only pause the reader once both active tracks have submitted enough media. */
export function canWaitForPlayback(readThrough: number, position: number, video: TrackBuffer | null, audio: TrackBuffer | null): boolean {
    if (readThrough <= position + 4.5) return false;
    const hasReserve = (track: TrackBuffer | null): boolean => {
        if (!track) return true;
        return covers(track.buffered, position, position + 2);
    };
    return hasReserve(video) && hasReserve(audio);
}
