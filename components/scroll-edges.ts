/**
 * A ref callback that marks which edges of a scroll container have content
 * hidden past them, as `data-edge-top` and `data-edge-bottom` ("true" or
 * "false"), for CSS to fade those edges.
 *
 * The scroll range is measured from the children's layout boxes rather than
 * `scrollHeight`, which also counts rows still moving in on a transform and
 * would flag an edge on a list that fits once they land. The container must
 * be positioned, so it is its children's offsetParent.
 */
export function trackScrollEdges(container: HTMLElement | null) {
  if (!container) return;

  const update = () => {
    const last = container.lastElementChild as HTMLElement | null;
    const padding = parseFloat(getComputedStyle(container).paddingBottom);
    const end = last ? last.offsetTop + last.offsetHeight + padding : 0;
    const range = end - container.clientHeight;
    container.dataset.edgeTop = String(container.scrollTop > 1);
    container.dataset.edgeBottom = String(container.scrollTop < range - 1);
  };

  const sizes = new ResizeObserver(update);
  const observeChildren = () => {
    sizes.disconnect();
    sizes.observe(container);
    for (const child of container.children) sizes.observe(child);
  };
  const children = new MutationObserver(() => {
    observeChildren();
    update();
  });

  observeChildren();
  children.observe(container, { childList: true });
  container.addEventListener("scroll", update, { passive: true });
  update();

  return () => {
    sizes.disconnect();
    children.disconnect();
    container.removeEventListener("scroll", update);
  };
}
