const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readDisplayTargets, prepareOverlays } = require('../dist/overlays');
const { layout, placement, install } = require('../media/hardware');

const overlay = (image, key = 'arrow_up') => `<overlay viewport_x="78" viewport_y="88" image_src_path="${image}" hidden="false"><button_overlay x="10" y="600" w="50" h="40" key="${key}" name="UP &amp; SELECT" help="Press &quot;up&quot;" color="0x2adef6"/></overlay>`;
const project = body => `<project name="fixture"><targets>${body}</targets></project>`;
const target = (name, width, height, body = '') => `<target name="${name}"><display width="${width}" height="${height}">${body}</display></target>`;

test('XML overlays follow their display target, prefer active declarations and preserve commented fallbacks', () => {
  const targets = readDisplayTargets(project(
    target('oled', 368, 448, '<!-- '+overlay('old.png')+' -->'+overlay('active.png', 'm'))+
    target('viewfinder', 1280, 960, '<!-- '+overlay('second.png')+' -->')+
    target('plain', 1600, 1200)
  ));
  assert.deepEqual(targets.map(t => [t.name, t.width, t.height]), [['oled',368,448],['viewfinder',1280,960],['plain',1600,1200]]);
  assert.equal(targets[0].overlay.image, 'active.png');
  assert.equal(targets[0].overlay.buttons[0].key, 'm');
  assert.equal(targets[1].overlay.image, 'second.png');
  assert.equal(targets[1].overlay.buttons[0].key, 'ArrowUp');
  assert.equal(targets[1].overlay.buttons[0].name, 'UP & SELECT');
  assert.equal(targets[1].overlay.buttons[0].help, 'Press "up"');
  assert.equal(targets[2].overlay, undefined);
  assert.throws(() => readDisplayTargets('<!DOCTYPE project><project/>'), /DOCTYPE/);
  assert.throws(() => readDisplayTargets(project(target('bad',368,448,overlay('x.png','bad_key')))), /key/);
  assert.throws(() => readDisplayTargets(project(target('bad',-1,448))), /width/);
});

test('display radius is read per active target and defaults to square corners', () => {
  const xml = project('<target name="watch"><display width="410" height="502" radius="120"/></target>' +
    '<!-- <target name="ignored"><display radius="999"/></target> -->' +
    target('square', 320, 240) + '<target name="round"><display width="240" height="240" radius="120"/></target>');
  assert.deepEqual(readDisplayTargets(xml).map(t => [t.name, t.radius]), [['watch', 120], ['square', 0], ['round', 120]]);
  assert.equal(readDisplayTargets('<project><display width="410" height="502" radius="120"/></project>')[0].radius, 120);
  for (const radius of ['-1', '1.5', 'NaN', 'Infinity', '120px', '8193', '']) {
    assert.throws(() => readDisplayTargets(`<project><display radius="${radius}"/></project>`), /radius/);
  }
});

test('overlay publication copies referenced images only, removes stale frames and rejects escaping paths and symlinks', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'lvgl-go-frames-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const ui = path.join(directory,'project'), output = path.join(directory,'output');
  await mkdir(path.join(ui,'images'),{recursive:true});
  await writeFile(path.join(ui,'images','frame.png'),'test image');
  await writeFile(path.join(ui,'images','private.c'),'private');
  await writeFile(path.join(ui,'project.xml'),project(target('oled',368,448,overlay('images/frame.png'))));
  await prepareOverlays(ui,output,'preview/index.html');
  const folder = path.join(output,'preview/lvgl-go-overlay');
  assert.deepEqual((await readdir(folder)).sort(),['frame-0.png','manifest.json']);
  const text = await readFile(path.join(folder,'manifest.json'),'utf8'), metadata = JSON.parse(text);
  assert.equal(metadata.targets[0].overlay.image,'frame-0.png');
  assert.equal(metadata.initial,0);
  assert(!text.includes(ui));assert(!text.includes('images/frame.png'));
  assert.equal(await readFile(path.join(folder,'frame-0.png'),'utf8'),'test image');
  await writeFile(path.join(ui,'project.xml'),project(target('oled',368,448,overlay('images/frame.png'))+target('viewfinder',1280,960,overlay('images/frame.png'))));
  await prepareOverlays(ui,output,'preview/index.html',{width:1280,height:960});
  assert.equal(JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8')).initial,1);
  for (const image of ['../private.png','/private.png','images/private.c']) {
    await writeFile(path.join(ui,'project.xml'),project(target('oled',368,448,overlay(image))));
    await assert.rejects(prepareOverlays(ui,output,'preview/index.html'));
  }
  await symlink(path.join(ui,'images/frame.png'),path.join(ui,'images/link.png'));
  await writeFile(path.join(ui,'project.xml'),project(target('oled',368,448,overlay('images/link.png'))));
  await assert.rejects(prepareOverlays(ui,output,'preview/index.html'),/symlink/);
  await writeFile(path.join(ui,'project.xml'),project('<target name="watch"><display width="410" height="502" radius="120"/></target>'));
  await prepareOverlays(ui,output,'preview/index.html');
  assert.deepEqual(await readdir(folder),['manifest.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8')).targets,
    [{name:'watch',width:410,height:502,radius:120}]);
});

test('hardware geometry scales image, viewport and button regions together while UI-only sizing stays natural', () => {
  const frame={x:78,y:88,width:523,height:773,buttons:[{x:291,y:654,width:52,height:40}]};
  const fit=layout(368,448,frame,844,303,'fit');
  assert.equal(fit.ratio,303/773);assert.equal(fit.x,78);assert.equal(fit.y,88);
  assert.equal(fit.width,523);assert.equal(fit.height,773);
  assert.equal(layout(368,448,null,844,900,'auto').ratio,1);
  assert.equal(layout(368,448,null,844,900,'fit').ratio,900/448);
});

test('odd-sized frames keep the UI on physical pixels without changing scale or frame/button geometry', () => {
  const frame = { x:198, y:138, width:716, height:517, buttons:[] };
  for (const dpr of [1, 1.25, 2, 3]) for (const height of [710, 711]) for (const mode of ['auto', 'fit']) {
    for (const artwork of [frame, null]) {
      const geometry = layout(320,240,artwork,1024,height,mode);
      const origin = placement(geometry,1024,height,dpr,0.25,89.125);
      const x = (origin.left + geometry.x * geometry.ratio + .25) * dpr;
      const y = (origin.top + geometry.y * geometry.ratio + 89.125) * dpr;
      assert(Math.abs(x-Math.round(x)) < 1e-8);
      assert(Math.abs(y-Math.round(y)) < 1e-8);
      assert(Math.abs(origin.left-(1024-geometry.width*geometry.ratio)/2) <= .5/dpr+1e-8);
      assert(Math.abs(origin.top-(height-geometry.height*geometry.ratio)/2) <= .5/dpr+1e-8);
      if (mode==='auto') assert.equal(geometry.ratio,1);
    }
  }
});

function hardwareFixture({ imageOk = true, manifestOk = true, hash = '', sharedImage = false, targets: customTargets } = {}) {
  const nodes=new Map(), images=[], keys=[], states=[], requests=[], revoked=[], events={};let blobId=0;
  const node=()=>({style:{},hidden:false,events:{},attributes:{},children:[],classList:new Set(),setAttribute(k,v){this.attributes[k]=v;},replaceChildren(...children){this.children=children;},contains(child){return child===this||this.children.includes(child);},addEventListener(k,v){this.events[k]=v;},setPointerCapture(){},focus(){}});
  for(const id of ['surface','hardware-stage','hardware-image','hardware-buttons','hardware-screen-hint'])nodes.set(id,node());
  nodes.get('hardware-stage').classList.remove = nodes.get('hardware-stage').classList.delete;
  Object.assign(nodes.get('surface'),{clientWidth:844,clientHeight:303});
  const canvas={...node(),width:368,height:448};
  let width=368,height=448;
  const targets=customTargets ?? [{name:'oled',width:368,height:448,overlay:{image:'frame-0.png',x:78,y:88,hidden:false,buttons:[{x:10,y:600,width:50,height:40,key:'ArrowUp',name:'UP',help:'Up',color:'#abcdef'}]}},
    {name:'viewfinder',width:1280,height:960,overlay:{image:'frame-1.png',x:770,y:990,hidden:false,buttons:[]}}, {name:'plain',width:1600,height:1200}];
  if(sharedImage)targets[1].overlay.image=targets[0].overlay.image;
  const module={_lvgl_go_display_width:()=>width,_lvgl_go_display_height:()=>height,_lvgl_go_set_display_size:(w,h)=>{width=w;height=h;return 1;}};
  const env={location:{href:'https://preview.test/bundle/revision/index.html',hash},innerWidth:844,innerHeight:303,
    document:{getElementById:id=>nodes.get(id),createElement:node},Image:class {constructor(){images.push(this);}},
    URL:{createObjectURL:()=> 'blob:frame-'+(++blobId),revokeObjectURL:url=>revoked.push(url)},
    addEventListener:(name,listener)=>{events[name]=listener;},
    fetch:async (url,options)=>{requests.push({url,options});return url.endsWith('manifest.json')?({ok:manifestOk,json:async()=>({version:1,targets})}):({ok:imageOk,blob:async()=>({})});}};
  const hardware=install(module,canvas,env,{key:event=>keys.push(event.key),changed:state=>states.push(state)});
  const load=(index,w,h)=>{Object.assign(images[index],{naturalWidth:w,naturalHeight:h});images[index].onload();};
  return {hardware,nodes,images,keys,states,canvas,module,load,requests,revoked,events};
}

test('frame toggle and target changes preserve the module, route touch keys, and follow live LVGL dimensions', async () => {
  const f=hardwareFixture();f.hardware.ready();await f.hardware.loaded;
  f.load(0,523,773);f.hardware.fit('fit');
  assert.equal(f.hardware.state().frameVisible,true);
  assert.equal(f.canvas.style.left,'78px');assert.equal(f.canvas.style.width,'368px');
  const button=f.nodes.get('hardware-buttons').children[0];
  button.events.pointerdown({button:0,pointerId:1,preventDefault(){}});
  assert.deepEqual(f.keys,['ArrowUp']);assert.equal(button.style.backgroundColor,'#abcdef55');
  button.events.pointercancel();assert.equal(button.style.backgroundColor,'transparent');
  f.hardware.handle({type:'lvgl-go-frame',visible:false});f.hardware.fit('fit');
  assert.equal(f.nodes.get('hardware-image').hidden,true);assert.equal(f.canvas.style.left,'0px');
  f.hardware.handle({type:'lvgl-go-select-display',index:1});
  assert.equal(f.hardware.state().current,1);assert.equal(f.hardware.state().frameVisible,false);
  f.hardware.handle({type:'lvgl-go-frame',visible:true});f.load(1,2931,3078);f.hardware.fit('fit');
  assert.equal(f.canvas.style.left,'770px');assert.equal(f.canvas.style.width,'1280px');
  assert.equal(f.nodes.get('hardware-buttons').children.length,0);
  f.hardware.handle({type:'lvgl-go-select-display',index:2});f.hardware.fit('fit');
  assert.equal(f.hardware.state().frameAvailable,false);assert.equal(f.canvas.style.left,'0px');
  f.module._lvgl_go_set_display_size(368,448);f.hardware.sync();
  assert.equal(f.hardware.state().current,0);assert.equal(f.hardware.state().frameVisible,true);
  for(const index of [-1,99,'1',NaN])f.hardware.handle({type:'lvgl-go-select-display',index});
  assert.equal(f.hardware.state().current,0);
});

test('radius follows display selection and live dimensions, scales with the stage and clears for legacy targets', async () => {
  const f=hardwareFixture({targets:[{name:'watch',width:410,height:502,radius:120},
    {name:'square',width:410,height:502,radius:0}, {name:'legacy',width:368,height:448}]});
  await f.hardware.ready();
  f.hardware.handle({type:'lvgl-go-select-display',index:0});
  for (const mode of ['auto','fit']) {
    f.hardware.fit(mode);
    assert.equal(f.canvas.style.borderRadius,'120px');
    assert.equal(f.nodes.get('hardware-screen-hint').style.borderRadius,'120px');
    assert.equal(f.nodes.get('hardware-stage').style.transform,`scale(${303/502})`);
    assert.equal(f.hardware.state().frameAvailable,false);
  }
  f.nodes.get('surface').clientWidth=1000;f.nodes.get('surface').clientHeight=1004;
  f.hardware.fit('auto');assert.equal(f.nodes.get('hardware-stage').style.transform,'none');
  f.hardware.fit('fit');assert.equal(f.nodes.get('hardware-stage').style.transform,'scale(2)');
  f.hardware.handle({type:'lvgl-go-select-display',index:1});f.hardware.fit('fit');
  assert.equal(f.canvas.style.borderRadius,'0px','Same-sized targets can have different radii');
  f.hardware.handle({type:'lvgl-go-select-display',index:0});
  f.module._lvgl_go_set_display_size(368,448);f.hardware.sync();f.hardware.fit('fit');
  assert.equal(f.canvas.style.borderRadius,'0px','Older metadata without radius retains square corners');
  f.module._lvgl_go_set_display_size(410,502);f.hardware.sync();f.hardware.fit('fit');
  assert.equal(f.canvas.style.borderRadius,'120px');
  f.module._lvgl_go_set_display_size(800,480);f.hardware.sync();f.hardware.fit('fit');
  assert.equal(f.canvas.style.borderRadius,'0px','Unmatched dimensions do not retain stale rounding');
});

test('rounding remains when a hardware frame is hidden or its image fails', async () => {
  for(const imageOk of [true,false]) {
    const f=hardwareFixture({imageOk,targets:[{name:'watch',width:368,height:448,radius:120,
      overlay:{image:'frame-0.png',x:78,y:88,hidden:false,buttons:[]}}]});
    const starting=f.hardware.ready();await f.hardware.loaded;
    if(imageOk)f.load(0,523,773);
    await starting;
    f.hardware.fit('fit');assert.equal(f.canvas.style.borderRadius,'120px');
    assert.equal(f.hardware.state().frameVisible,imageOk);
    f.hardware.handle({type:'lvgl-go-frame',visible:false});f.hardware.fit('fit');
    assert.equal(f.canvas.style.borderRadius,'120px');assert.equal(f.canvas.style.left,'0px');
  }
});

test('startup restores the selected display while preloading all frames even when hardware is hidden', async () => {
  const f=hardwareFixture({hash:'#lvgl-go-display=viewfinder&lvgl-go-frame=1'});
  const starting=f.hardware.ready();await f.hardware.loaded;
  assert.equal(f.images.length,2);assert.equal(f.hardware.state().current,1);
  f.load(0,523,773);f.load(1,2931,3078);await starting;
  f.hardware.fit('fit');assert.equal(f.canvas.style.left,'770px');
  const hidden=hardwareFixture({hash:'#lvgl-go-display=viewfinder&lvgl-go-frame=0'});
  const hiddenStarting=hidden.hardware.ready();await hidden.hardware.loaded;
  assert.equal(hidden.images.length,2);assert.equal(hidden.hardware.state().current,1);
  hidden.load(0,523,773);hidden.load(1,2931,3078);await hiddenStarting;
  assert.equal(hidden.hardware.state().frameVisible,false);
  const count=hidden.requests.length;
  hidden.hardware.handle({type:'lvgl-go-frame',visible:true});
  assert.equal(hidden.nodes.get('hardware-image').src,hidden.images[1].src);
  assert.equal(hidden.hardware.state().frameVisible,true);assert.equal(hidden.requests.length,count);
});

test('hardware startup waits for every frame to download and decode, then target changes reuse ready images', async () => {
  const f=hardwareFixture();
  let decode, ready=false;
  f.nodes.get('hardware-image').decode=()=>new Promise(resolve=>{decode=resolve;});
  const starting=f.hardware.ready().then(()=>{ready=true;});
  await f.hardware.loaded;
  assert.equal(f.images.length,2);assert(!ready);
  f.load(0,523,773);
  await new Promise(resolve=>setImmediate(resolve));
  assert(!ready,'A background target must also finish loading');
  let decodeOther;
  f.images[1].decode=()=>new Promise(resolve=>{decodeOther=resolve;});
  f.load(1,2931,3078);
  await new Promise(resolve=>setImmediate(resolve));
  assert(!ready,'The other target must be decoded before startup finishes');
  decodeOther();
  await new Promise(resolve=>setImmediate(resolve));
  assert(!ready,'Image decode must finish before the preview is ready');
  decode();await starting;
  assert(ready);assert(f.hardware.state().frameVisible);
  const count=f.requests.length;
  f.hardware.handle({type:'lvgl-go-select-display',index:1});f.hardware.fit('fit');
  assert.equal(f.requests.length,count,'Changing targets must not download an image again');
  assert.equal(f.images.length,2);
  assert.equal(f.nodes.get('hardware-image').src,f.images[1].src);
  assert.equal(f.canvas.style.left,'770px');
});

test('missing or broken hardware images fall back to UI-only startup instead of leaving loading stuck', async () => {
  for(const options of [{imageOk:false},{manifestOk:false}]) {
    const f=hardwareFixture(options);
    await f.hardware.ready();
    assert.equal(f.hardware.state().frameVisible,false);
    assert.equal(f.nodes.get('hardware-image').hidden,true);
  }
  const f=hardwareFixture();
  const starting=f.hardware.ready();await f.hardware.loaded;
  f.nodes.get('hardware-image').decode=async()=>{throw new Error('Invalid image');};
  f.load(0,523,773);f.load(1,2931,3078);await starting;
  assert.equal(f.hardware.state().frameVisible,false);
  assert.equal(f.nodes.get('hardware-image').hidden,true);
});

test('shared frame URLs are downloaded once and one broken target does not prevent startup', async () => {
  const shared=hardwareFixture({sharedImage:true});
  const sharedReady=shared.hardware.ready();await shared.hardware.loaded;
  assert.equal(shared.images.length,1);shared.load(0,523,773);await sharedReady;
  assert.equal(shared.requests.filter(request=>request.url.endsWith('frame-0.png')).length,1);
  const f=hardwareFixture();const ready=f.hardware.ready();await f.hardware.loaded;
  f.load(0,523,773);f.images[1].onerror();await ready;
  assert.equal(f.hardware.state().frameVisible,true);
  f.hardware.handle({type:'lvgl-go-select-display',index:1});
  assert.equal(f.hardware.state().frameAvailable,false);assert.equal(f.hardware.state().frameVisible,false);
});

test('leaving a preview releases all preloaded image URLs and aborts its requests', async () => {
  const f=hardwareFixture();const ready=f.hardware.ready();await f.hardware.loaded;
  f.load(0,523,773);f.load(1,2931,3078);await ready;
  f.events.pagehide({persisted:true});assert.equal(f.revoked.length,0);
  f.events.pagehide({persisted:false});
  assert.deepEqual(f.revoked.sort(),f.images.map(image=>image.src).sort());
  assert(f.requests.every(request=>request.options.signal.aborted));
});

test('missed touches reveal screen and button regions only while an actual hardware frame is visible', async () => {
  const f=hardwareFixture(), stage=f.nodes.get('hardware-stage'), surface=f.nodes.get('surface');
  let prevented=0, focused=0;
  f.canvas.focus=()=>focused++;
  const touch=(target,button=0)=>surface.events.pointerdown({target,button,preventDefault(){prevented++;}});
  const flashing=()=>stage.classList.has('hardware-hint');
  touch(stage);assert(!flashing());
  f.hardware.ready();await f.hardware.loaded;
  touch(stage);assert(!flashing(),'An image still loading does not reveal inactive regions');
  f.load(0,523,773);f.hardware.fit('fit');
  assert.deepEqual(f.nodes.get('hardware-screen-hint').style,f.canvas.style);
  touch(f.canvas);assert(!flashing());
  touch(f.nodes.get('hardware-buttons').children[0]);assert(!flashing());
  touch(stage,2);assert(!flashing());
  touch(stage);assert(flashing());assert.equal(prevented,1);assert.equal(focused,1);
  touch(surface);assert(flashing());assert.equal(prevented,2);
  assert.deepEqual(f.keys,[],'Hints never send simulated hardware keys');
  f.hardware.handle({type:'lvgl-go-frame',visible:false});
  assert(!flashing());touch(surface);assert(!flashing());
  f.hardware.handle({type:'lvgl-go-frame',visible:true});
  touch(stage);assert(flashing());
  f.hardware.handle({type:'lvgl-go-select-display',index:1});
  assert(!flashing(),'Changing frames clears the previous hint');
  f.load(1,2931,3078);f.hardware.fit('fit');
  touch(surface);assert(flashing(),'Frames with no buttons still highlight the UI');
  f.hardware.handle({type:'lvgl-go-select-display',index:2});
  assert(!flashing());touch(surface);assert(!flashing());
});
