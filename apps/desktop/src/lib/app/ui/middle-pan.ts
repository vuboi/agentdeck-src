/** Pan a scrollable viewport with the middle mouse button. */
export function middlePan(node: HTMLElement) {
    let pan: {
        pointerId: number;
        x: number;
        y: number;
        left: number;
        top: number;
    } | null = null;

    function stop(event?: PointerEvent) {
        if (!pan || (event && event.pointerId !== pan.pointerId)) return;
        if (event && node.hasPointerCapture(event.pointerId))
            node.releasePointerCapture(event.pointerId);
        pan = null;
        node.classList.remove('middle-pan-active');
    }

    function onPointerDown(event: PointerEvent) {
        if (event.button !== 1) return;
        event.preventDefault();
        pan = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: node.scrollLeft,
            top: node.scrollTop,
        };
        node.setPointerCapture(event.pointerId);
        node.classList.add('middle-pan-active');
    }

    function onPointerMove(event: PointerEvent) {
        if (!pan || event.pointerId !== pan.pointerId) return;
        node.scrollLeft = pan.left - (event.clientX - pan.x);
        node.scrollTop = pan.top - (event.clientY - pan.y);
    }

    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', stop);
    node.addEventListener('pointercancel', stop);
    node.addEventListener('lostpointercapture', stop);

    return {
        destroy() {
            stop();
            node.removeEventListener('pointerdown', onPointerDown);
            node.removeEventListener('pointermove', onPointerMove);
            node.removeEventListener('pointerup', stop);
            node.removeEventListener('pointercancel', stop);
            node.removeEventListener('lostpointercapture', stop);
        },
    };
}
