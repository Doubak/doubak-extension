/* 【自动同步，请勿手改】来自 doubak-site-generator 的 src/avatar-image.js
 * 改动请在那个仓库里做，然后运行 node tools/sync-vendor.mjs。
 * 理由见 tools/sync-vendor.mjs：两份实现对同一段输入得出不同结论，只是早晚的事。
 */
/** Bounded raster header/structure validation, shared with the capture host.
 * Pixel decoding is performed by Hugo, with a guarded fallback to a text header.
 * No SVG/HTML, no MIME-only acceptance, no decoder allocation before size limits.
 */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export function inspectAvatar(bytes, contentType) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_AVATAR_BYTES) throw new Error('头像字节为空或超过 5 MiB');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
  let width, height, mime, ext;
  if (bytes.length >= 33 && ascii(1, 4) === 'PNG' && bytes[0] === 137 && ascii(4,8) === '\r\n\x1a\n') {
    mime = 'image/png'; ext = 'png';
    if (ascii(12,16) !== 'IHDR' || v.getUint32(8) !== 13) throw new Error('PNG 缺少 IHDR');
    width=v.getUint32(16); height=v.getUint32(20);
    let end=false, data=false;
    for(let p=8; p+12<=bytes.length;) {
      const n=v.getUint32(p), type=ascii(p+4,p+8);
      if(p+12+n>bytes.length) throw new Error('PNG 块被截断');
      let crc=0xffffffff;
      for(let i=p+4;i<p+8+n;i++) { crc^=bytes[i]; for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
      if(((crc^0xffffffff)>>>0)!==v.getUint32(p+8+n)) throw new Error('PNG CRC 不一致');
      if(type==='IDAT') data=true;
      p+=12+n;
      if(type==='IEND') { end=n===0&&p===bytes.length; break; }
    }
    if(!end||!data) throw new Error('PNG 缺少图像或结尾');
  } else if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(0,6))) {
    mime='image/gif'; ext='gif'; width=v.getUint16(6,true); height=v.getUint16(8,true);
    if(bytes.at(-1)!==0x3b || !bytes.includes(0x2c,10)) throw new Error('GIF 被截断');
  } else if (bytes.length>=12 && bytes[0]===255 && bytes[1]===216) {
    mime='image/jpeg'; ext='jpg';
    if(bytes.at(-2)!==255 || bytes.at(-1)!==217) throw new Error('JPEG 被截断');
    for(let p=2;p+4<bytes.length;) {
      if(bytes[p++]!==255) break;
      while(bytes[p]===255) p++;
      const tag=bytes[p++];
      if(tag===0xda || tag===0xd9) break;
      if(tag===0x01 || (tag>=0xd0 && tag<=0xd7)) continue;
      const n=v.getUint16(p); if(n<2 || p+n>bytes.length) break;
      if([0xc0,0xc1,0xc2].includes(tag)&&n>=8) { height=v.getUint16(p+3); width=v.getUint16(p+5); }
      p+=n;
    }
  } else if(bytes.length>=30 && ascii(0,4)==='RIFF' && ascii(8,12)==='WEBP') {
    mime='image/webp'; ext='webp';
    if(v.getUint32(4,true)+8!==bytes.length) throw new Error('WebP 被截断');
    const kind=ascii(12,16);
    if(kind==='VP8X') { width=1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16); height=1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16); }
    else if(kind==='VP8 ' && ascii(23,26)==='\x9d\x01\x2a') { width=v.getUint16(26,true)&0x3fff; height=v.getUint16(28,true)&0x3fff; }
    else if(kind==='VP8L' && bytes[20]===0x2f) { const x=v.getUint32(21,true); width=1+(x&0x3fff);height=1+((x>>>14)&0x3fff); }
  }
  if(!width||!height||width>4096||height>4096||width*height>16000000) throw new Error('头像格式或尺寸不受支持');
  if(contentType?.split(';')[0].trim().toLowerCase()!==mime) throw new Error('头像 MIME 与字节不一致');
  return { width, height, mime, ext };
}
