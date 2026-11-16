/** Modern window chrome is opt-in; deployed classic clients retain their window settings. */
export const captionHeight=40;
export function desktopAppId(config){return config.dataNamespace?.startsWith('v08-')?'com.tongzhou.framework.preview.v08':config.dataNamespace?.startsWith('v07-')?'com.tongzhou.framework.preview.v07':'com.tongzhou.studio';}
export function desktopChrome(config,platform){
    if(config.integratedChrome!==true||platform!=='win32')return{};
    return{titleBarStyle:'hidden',titleBarOverlay:{height:captionHeight,color:'#f5f7f8',symbolColor:'#24332e'},autoHideMenuBar:true};
}
export function captionMenuPoint(point,zoom,bounds){
    if(!point||!Number.isInteger(point.x)||!Number.isInteger(point.y)||point.x<0||point.y<0||!Number.isFinite(zoom)||zoom<=0)throw Error('Invalid menu position');
    const x=Math.round(point.x*zoom),y=Math.round(point.y*zoom);
    if(x>bounds.width||y>bounds.height)throw Error('Menu position is outside this window');
    return{x,y};
}
