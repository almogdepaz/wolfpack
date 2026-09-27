import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start, skipIfNoBroker, type BrokerTestServer } from './broker-helpers.ts';
import { createOwnedTestServerHome, removeOwnedTestServerHome, type OwnedTestServerHome } from './test-server-home.ts';
import { openSettingsFromUi } from './helpers.ts';

test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
let server: BrokerTestServer, home: OwnedTestServerHome, root: string;
test.beforeAll(async()=>{
 if(skipIfNoBroker.condition)return;
 root=realpathSync(mkdtempSync(join(tmpdir(),'wp-desktop-tools-')));mkdirSync(join(root,'project'));
 home=createOwnedTestServerHome();
 server=await start({envOverrides:{HOME:home.path,WOLFPACK_DEV_DIR:root,WOLFPACK_MACHINE_ID_PATH:join(home.path,'machine-id')}});
 for(const name of ['tools-one','tools-two']){
  const response=await fetch(server.baseUrl+'/api/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:'project',cmd:'shell',sessionName:name})});
  expect(response.ok).toBe(true);
 }
});
test.afterAll(async()=>{await server?.teardown();if(home)removeOwnedTestServerHome(home);if(root)rmSync(root,{recursive:true,force:true})});

test('widget controls sit beside All/Idle without a Workspace tools section or terminal remount',async({page},info)=>{
 test.skip(info.project.name!=='desktop','Desktop session controls');
 const sockets:string[]=[];page.on('websocket',socket=>{if(socket.url().includes('/ws/pty'))sockets.push(socket.url())});
 await page.goto(server.baseUrl);await page.locator('.card',{hasText:'tools-one'}).first().click();
 const canvas=page.locator('#desktop-terminal-container canvas');await expect(canvas).toBeVisible();
 expect(await page.evaluate(()=>({privateView:typeof (window as any).showView,hooks:Object.keys((window as any).__wolfpackTest)}))).toEqual({privateView:'undefined',hooks:['serializeTerminalTail']});
 await expect(page.locator('#workspace-tools, #workspace-settings-dialog, #workspace-session-actions, #terminal-transcript-btn')).toHaveCount(0);
 await expect(page.locator('.workspace-terminal-toolbar')).toBeHidden();
 const row=page.locator('#sidebar-session-controls');
 const filter=row.getByRole('group',{name:'Session view'});
 const hide=row.getByRole('button',{name:'Hide widgets',exact:true});
 await expect(hide).toBeVisible();
 const pill=(await filter.boundingBox())!, box=(await hide.boundingBox())!;
 expect(box.x).toBeGreaterThanOrEqual(pill.x+pill.width);
 expect(Math.abs(box.y+box.height/2-pill.y-pill.height/2)).toBeLessThanOrEqual(1);
 await canvas.evaluate(node=>{(window as any).__toolsCanvas=node});const attached=sockets.length;
 await hide.click();const show=row.getByRole('button',{name:'Show widgets',exact:true});
 await expect(show).toBeFocused();expect(await show.boundingBox()).toEqual(box);
 await show.press('Enter');await expect(hide).toBeFocused();
 // Polling/filter renders must not replace the stable widget controls or lose focus.
 await filter.getByRole('button',{name:'Idle sessions'}).click();
 await hide.focus();await page.waitForTimeout(350);await expect(hide).toBeFocused();
 await filter.getByRole('button',{name:'All sessions'}).click();
 await page.locator('[data-widget-full]:visible').click();await hide.click();
 await expect(page.locator('#workspace-context-region')).toBeHidden();await show.click();
 expect(await canvas.evaluate(node=>node===(window as any).__toolsCanvas)).toBe(true);expect(sockets).toHaveLength(attached);
 await page.getByRole('button',{name:'Expand sessions',exact:true}).click();
 await expect(page.locator('#session-dashboard-controls #workspace-context-collapse')).toBeVisible();
 await page.getByRole('button',{name:'Collapse sessions',exact:true}).click();
 await expect(hide).toBeVisible();
 await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state','live');
 await page.screenshot({path:info.outputPath('session-controls.png')});
});

test('terminal layout lives in Settings and survives return and reload without a Transcript button',async({page},info)=>{
 await page.goto(server.baseUrl);
 await openSettingsFromUi(page);
 await expect(page.getByRole('region',{name:'Settings',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Terminal',exact:true}).click();
 const picker=page.locator('#settings-terminal').getByRole('combobox',{name:'Terminal layout',exact:true});
 await expect(picker).toHaveCSS('appearance','auto');await picker.selectOption('lead-stack');
 await page.locator(info.project.name==='desktop'?'#settings-back-btn':'#back-btn').click();
 await page.locator('.card',{hasText:'tools-one'}).filter({visible:true}).first().click();
 await expect(page.locator('#desktop-terminal-container canvas')).toBeVisible();
 await expect(page.locator('#terminal-transcript-btn')).toHaveCount(0);
 await expect(page.locator('.workspace-terminal-toolbar select')).toHaveCount(0);
 expect(await page.evaluate(()=>localStorage.getItem('wolfpack-terminal-layout'))).toBe('lead-stack');
 await page.reload();await expect(page.locator('#settings-view')).toBeVisible();
 await expect(picker).toHaveValue('lead-stack');
 await expect(page.locator('.view.visible')).toHaveCount(1);
 await expect(page.locator('#settings-view')).not.toHaveClass(/swiping/);
 await expect(picker).toBeInViewport();
 await page.screenshot({path:info.outputPath('terminal-settings.png')});
});

test('unpinned sidebar retains keyboard access to the widget toggle',async({page},info)=>{
 test.skip(info.project.name!=='desktop','Desktop hover sidebar');
 await page.addInitScript(()=>localStorage.setItem('wolfpack-sidebar-pinned','0'));
 await page.goto(server.baseUrl);await page.locator('.card',{hasText:'tools-one'}).filter({visible:true}).first().click();
 await expect(page.locator('#desktop-terminal-container canvas')).toBeVisible();
 await page.keyboard.press('Meta+b');await expect(page.locator('#sidebar-session-controls')).toBeVisible();
 await page.mouse.move(700,300);await page.keyboard.press('Meta+b');
 await expect(page.locator('#desktop-sidebar')).toHaveClass(/collapsed/);
 const edge=(await page.locator('#sidebar-hover-edge').boundingBox())!;
 await page.mouse.move(edge.x+edge.width/2,edge.y+100);
 const hide=page.locator('#sidebar-session-controls #workspace-context-collapse');await expect(hide).toBeVisible();
 await hide.click();await page.mouse.move(700,300);await page.waitForTimeout(350);
 await expect(page.locator('#desktop-sidebar')).not.toHaveClass(/collapsed/);
 await expect(page.locator('#workspace-restore')).toBeFocused();
 await page.keyboard.press('Enter');await expect(hide).toBeFocused();
});

test('widget controls retain one owner across desktop and mobile',async({page},info)=>{
 test.skip(info.project.name!=='desktop','Desktop to mobile responsive ownership');
 await page.goto(server.baseUrl);await page.locator('.card',{hasText:'tools-two'}).first().click();
 await expect(page.locator('#sidebar-session-controls #workspace-context-collapse')).toBeVisible();
 await page.setViewportSize({width:390,height:844});
 const toolbar=page.locator('.workspace-terminal-toolbar');await expect(toolbar).toBeVisible();
 await expect(toolbar.locator('#workspace-restore')).toHaveAccessibleName('Expand context panel');
 await toolbar.locator('#workspace-restore').click();
 await page.getByRole('button',{name:'Back to terminal',exact:true}).click();
 await expect(toolbar.locator('select, #terminal-transcript-btn')).toHaveCount(0);
 await page.setViewportSize({width:1280,height:720});
 await expect(toolbar).toBeHidden();await expect(page.locator('#sidebar-session-controls #workspace-context-collapse')).toBeVisible();
 await expect(page.locator('#workspace-context-collapse')).toHaveCount(1);
});
