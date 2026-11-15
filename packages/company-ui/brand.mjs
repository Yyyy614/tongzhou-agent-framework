export const productName='同舟';
export const productTagline='你的智能工作空间';
// Original mark: two cooperating sails above one hull. No third-party brand asset.
export const markPaths=['M8 24h24l-4 5H12z','M18 7v14H8z','M22 10v11h9z'];
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="12" fill="#126c61"/><g fill="#fff">'+markPaths.map(d=>'<path d="'+d+'"/>').join('')+'</g></svg>';
export const brandMark='data:image/svg+xml,'+encodeURIComponent(svg);
