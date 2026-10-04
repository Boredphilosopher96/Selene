/** Compare physical target bounds separately from the integer DOM scrollport.
 * DOMRect dimensions can be fractional; client/scroll dimensions use rounded
 * CSS pixels. Mixing those units creates false overflow on native HiDPI views.
 */
export function inspectorTabHasUsableGeometry(tab) {
  return (
    tab.visible &&
    Number.isFinite(tab.width) &&
    Number.isFinite(tab.height) &&
    tab.width >= 100 &&
    tab.height >= 34 &&
    [tab.clientWidth, tab.clientHeight, tab.scrollWidth, tab.scrollHeight].every(
      Number.isInteger
    ) &&
    tab.clientWidth > 0 &&
    tab.clientHeight > 0 &&
    tab.scrollWidth >= 0 &&
    tab.scrollHeight >= 0 &&
    tab.scrollWidth <= tab.clientWidth &&
    tab.scrollHeight <= tab.clientHeight
  );
}
