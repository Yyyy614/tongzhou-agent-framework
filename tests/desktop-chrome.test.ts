import{test,expect}from'vitest';

test('studio window has integrated native caption controls while classic windows retain their configuration',async()=>{
    const{desktopChrome}=await import('../desktop/chrome.mjs');
    expect(desktopChrome({integratedChrome:true},'win32')).toMatchObject({titleBarStyle:'hidden',titleBarOverlay:{height:40,symbolColor:'#24332e'},autoHideMenuBar:true});
    expect(desktopChrome({},'win32')).toEqual({});
    expect(desktopChrome({integratedChrome:true},'linux')).toEqual({});
});

test('caption menu stays anchored after application zoom and rejects coordinates outside the native window',async()=>{
    const{captionMenuPoint}=await import('../desktop/chrome.mjs');
    expect(captionMenuPoint({x:60,y:36},1.5,{width:1240,height:860})).toEqual({x:90,y:54});
    expect(captionMenuPoint({x:60,y:36},0.8,{width:1240,height:860})).toEqual({x:48,y:29});
    expect(()=>captionMenuPoint({x:900,y:36},2,{width:1240,height:860})).toThrow();
    expect(()=>captionMenuPoint({x:-1,y:20},1,{width:1240,height:860})).toThrow();
});
