const glsl = x => x;
const frag = glsl`
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// FidelityFX FSR v1.0.2 by AMD
// ported to mpv by agyild - https://gist.github.com/agyild/82219c545228d70c5604f865ce0b0ce5
// ported to WebGL by goingdigital - https://www.shadertoy.com/view/stXSWB
// using glea.js by learosema - https://github.com/learosema/glea for webGL functions
// using colorspace functions from tobspr - https://github.com/tobspr/GLSL-Color-Spaces/blob/master/ColorSpaces.inc.glsl

#define SHARPENING 2.0 // Sharpening intensity: Adjusts sharpening intensity by averaging the original pixels to the sharpened result. 1.0 is the unmodified default. 0.0 to 1.0.
#define CONTRAST 2.0 // Adjusts the range the shader adapts to high contrast (0 is not all the way off). Higher values = more high contrast sharpening. 0.0 to 1.0.
#define PERFORMANCE 1 // Whether to use optimizations for performance with loss of quality

precision highp float;

uniform float width;
uniform float height;
uniform float texWidth;
uniform float texHeight;

float width_half;

uniform sampler2D camTexture;

// Used to convert from linear RGB to XYZ space
const mat3 RGB_2_XYZ = (mat3(
    0.4124564, 0.2126729, 0.0193339,
    0.3575761, 0.7151522, 0.1191920,
    0.1804375, 0.0721750, 0.9503041
));

// Used to convert from XYZ to linear RGB space
const mat3 XYZ_2_RGB = (mat3(
     3.2404542,-0.9692660, 0.0556434,
    -1.5371385, 1.8760108,-0.2040259,
    -0.4985314, 0.0415560, 1.0572252
));
// Converts a color from linear RGB to XYZ space
vec3 rgb_to_xyz(vec3 rgb) {
    return RGB_2_XYZ * rgb;
}

// Converts a color from XYZ to linear RGB space
vec3 xyz_to_rgb(vec3 xyz) {
    return XYZ_2_RGB * xyz;
}

/* EASU stage
*
* This takes a reduced resolution source, and scales it up while preserving detail.
*
* Updates:
*   stretch definition fixed. Thanks nehon for the bug report!
*/

vec3 FsrEasuCF(vec2 p) {
	vec2 uv = (p + .5) / vec2(texWidth, texHeight);
	vec4 color = texture2D(camTexture, uv);
    return rgb_to_xyz(color.rgb);
}

/**** EASU ****/
void FsrEasuCon(
    out vec4 con0,
    out vec4 con1,
    out vec4 con2,
    out vec4 con3,
    // This the rendered image resolution being upscaled
    vec2 inputViewportInPixels,
    // This is the resolution of the resource containing the input image (useful for dynamic resolution)
    vec2 inputSizeInPixels,
    // This is the display resolution which the input image gets upscaled to
    vec2 outputSizeInPixels
)
{
    // Output integer position to a pixel position in viewport.
    con0 = vec4(
        inputViewportInPixels.x/outputSizeInPixels.x,
        inputViewportInPixels.y/outputSizeInPixels.y,
        .5*inputViewportInPixels.x/outputSizeInPixels.x-.5,
        .5*inputViewportInPixels.y/outputSizeInPixels.y-.5
    );
    // Viewport pixel position to normalized image space.
    // This is used to get upper-left of 'F' tap.
    con1 = vec4(1,1,1,-1)/inputSizeInPixels.xyxy;
    // Centers of gather4, first offset from upper-left of 'F'.
    //      +---+---+
    //      |   |   |
    //      +--(0)--+
    //      | b | c |
    //  +---F---+---+---+
    //  | e | f | g | h |
    //  +--(1)--+--(2)--+
    //  | i | j | k | l |
    //  +---+---+---+---+
    //      | n | o |
    //      +--(3)--+
    //      |   |   |
    //      +---+---+
    // These are from (0) instead of 'F'.
    con2 = vec4(-1,2,1,2)/inputSizeInPixels.xyxy;
    con3 = vec4(0,4,0,0)/inputSizeInPixels.xyxy;
}

// Filtering for a given tap for the scalar.
void FsrEasuTapF(
    inout vec3 aC, // Accumulated color, with negative lobe.
    inout float aW, // Accumulated weight.
    vec2 off, // Pixel offset from resolve position to tap.
    vec2 dir, // Gradient direction.
    vec2 len, // Length.
    float lob, // Negative lobe strength.
    float clp, // Clipping point.
    vec3 c
)
{
    // Tap color.
    // Rotate offset by direction.
    vec2 v = vec2(dot(off, dir), dot(off,vec2(-dir.y,dir.x)));
    // Anisotropy.
    v *= len;
    // Compute distance^2.
    float d2 = min(dot(v,v),clp);
    // Limit to the window as at corner, 2 taps can easily be outside.
    // Approximation of lancos2 without sin() or rcp(), or sqrt() to get x.
    //  (25/16 * (2/5 * x^2 - 1)^2 - (25/16 - 1)) * (1/4 * x^2 - 1)^2
    //  |_______________________________________|   |_______________|
    //                   base                             window
    // The general form of the 'base' is,
    //  (a*(b*x^2-1)^2-(a-1))
    // Where 'a=1/(2*b-b^2)' and 'b' moves around the negative lobe.
    float wB = .4 * d2 - 1.;
    float wA = lob * d2 -1.;
    wB *= wB;
    wA *= wA;
    wB = 1.5625*wB-.5625;
    float w=  wB * wA;
    // Do weighted average.
    aC += c*w;
    aW += w;
}

//------------------------------------------------------------------------------------------------------------------------------
// Accumulate direction and length.
void FsrEasuSetF(
    inout vec2 dir,
    inout float len,
    float w,
    float lA,float lB,float lC,float lD,float lE
)
{
    // Direction is the '+' diff.
    //    a
    //  b c d
    //    e
    // Then takes magnitude from abs average of both sides of 'c'.
    // Length converts gradient reversal to 0, smoothly to non-reversal at 1, shaped, then adding horz and vert terms.
    float lenX = max(abs(lD - lC), abs(lC - lB));
    float dirX = lD - lB;
    dir.x += dirX * w;
    lenX = clamp(abs(dirX)/lenX,0.,1.);
    lenX *= lenX;
    len += lenX * w;
    // Repeat for the y axis.
    float lenY = max(abs(lE - lC), abs(lC - lA));
    float dirY = lE - lA;
    dir.y += dirY * w;
    lenY = clamp(abs(dirY) / lenY,0.,1.);
    lenY *= lenY;
    len += lenY * w;
}

//------------------------------------------------------------------------------------------------------------------------------
void FsrEasuF(
    out vec3 pix,
    vec2 ip, // Integer pixel position in output.
    // Constants generated by FsrEasuCon().
    vec4 con0, // xy = output to input scale, zw = first pixel offset correction
    vec4 con1,
    vec4 con2,
    vec4 con3
)
{
    //------------------------------------------------------------------------------------------------------------------------------
    // Get position of 'f'.
    vec2 pp = ip * con0.xy + con0.zw; // Corresponding input pixel/subpixel
    vec2 fp = floor(pp);// fp = source nearest pixel
    pp -= fp; // pp = source subpixel

    //------------------------------------------------------------------------------------------------------------------------------
    // 12-tap kernel.
    //    b c
    //  e f g h
    //  i j k l
    //    n o
    // Gather 4 ordering.
    //  a b
    //  r g
    vec2 p0 = fp * con1.xy + con1.zw;
    
    // These are from p0 to avoid pulling two constants on pre-Navi hardware.
    vec2 p1 = p0 + con2.xy;
    vec2 p2 = p0 + con2.zw;
    vec2 p3 = p0 + con3.xy;

    // TextureGather is not available on WebGL2
    vec4 off = vec4(-.5,.5,-.5,.5)*con1.xxyy;
    // textureGather to texture offsets
    // x=west y=east z=north w=south
    vec3 bC = FsrEasuCF(p0 + off.xw); float bL = bC.g + 0.5 *(bC.r + bC.b);
    vec3 cC = FsrEasuCF(p0 + off.yw); float cL = cC.g + 0.5 *(cC.r + cC.b);
    vec3 iC = FsrEasuCF(p1 + off.xw); float iL = iC.g + 0.5 *(iC.r + iC.b);
    vec3 jC = FsrEasuCF(p1 + off.yw); float jL = jC.g + 0.5 *(jC.r + jC.b);
    vec3 fC = FsrEasuCF(p1 + off.yz); float fL = fC.g + 0.5 *(fC.r + fC.b);
    vec3 eC = FsrEasuCF(p1 + off.xz); float eL = eC.g + 0.5 *(eC.r + eC.b);
    vec3 kC = FsrEasuCF(p2 + off.xw); float kL = kC.g + 0.5 *(kC.r + kC.b);
    vec3 lC = FsrEasuCF(p2 + off.yw); float lL = lC.g + 0.5 *(lC.r + lC.b);
    vec3 hC = FsrEasuCF(p2 + off.yz); float hL = hC.g + 0.5 *(hC.r + hC.b);
    vec3 gC = FsrEasuCF(p2 + off.xz); float gL = gC.g + 0.5 *(gC.r + gC.b);
    vec3 oC = FsrEasuCF(p3 + off.yz); float oL = oC.g + 0.5 *(oC.r + oC.b);
    vec3 nC = FsrEasuCF(p3 + off.xz); float nL = nC.g + 0.5 *(nC.r + nC.b);
   
    //------------------------------------------------------------------------------------------------------------------------------
    // Simplest multi-channel approximate luma possible (luma times 2, in 2 FMA/MAD).
    // Accumulate for bilinear interpolation.
    vec2 dir = vec2(0);
    float len = 0.;

    FsrEasuSetF(dir, len, (1.-pp.x)*(1.-pp.y), bL, eL, fL, gL, jL);
    FsrEasuSetF(dir, len,    pp.x  *(1.-pp.y), cL, fL, gL, hL, kL);
    FsrEasuSetF(dir, len, (1.-pp.x)*  pp.y  , fL, iL, jL, kL, nL);
    FsrEasuSetF(dir, len,    pp.x  *  pp.y  , gL, jL, kL, lL, oL);

    //------------------------------------------------------------------------------------------------------------------------------
    // Normalize with approximation, and cleanup close to zero.
    vec2 dir2 = dir * dir;
    float dirR = dir2.x + dir2.y;
    bool zro = dirR < (1.0/32768.0);
    dirR = inversesqrt(dirR);
#if (PERFORMANCE == 1)
	if (zro) {
		vec4 w = vec4(0.0);
		w.x = (1.0 - pp.x) * (1.0 - pp.y);
		w.y =        pp.x  * (1.0 - pp.y);
		w.z = (1.0 - pp.x) *        pp.y;
		w.w =        pp.x  *        pp.y;
		pix.r = clamp(dot(w, vec4(fL, gL, jL, kL)), 0.0, 1.0);
		return;
	}
#elif (PERFORMANCE == 0)
    dirR = zro ? 1.0 : dirR;
    dir.x = zro ? 1.0 : dir.x;
#endif
    dir *= vec2(dirR);
    // Transform from {0 to 2} to {0 to 1} range, and shape with square.
    len = len * 0.5;
    len *= len;
    // Stretch kernel {1.0 vert|horz, to sqrt(2.0) on diagonal}.
    float stretch = dot(dir,dir) / (max(abs(dir.x), abs(dir.y)));
    // Anisotropic length after rotation,
    //  x := 1.0 lerp to 'stretch' on edges
    //  y := 1.0 lerp to 2x on edges
    vec2 len2 = vec2(1. +(stretch-1.0)*len, 1. -.5 * len);
    // Based on the amount of 'edge',
    // the window shifts from +/-{sqrt(2.0) to slightly beyond 2.0}.
    float lob = .5 - .29 * len;
    // Set distance^2 clipping point to the end of the adjustable window.
    float clp = 1./lob;

    //------------------------------------------------------------------------------------------------------------------------------
    // Accumulation mixed with min/max of 4 nearest.
    //    b c
    //  e f g h
    //  i j k l
    //    n o
    // Accumulation.
    vec3 aC = vec3(0);
    float aW = 0.;
    FsrEasuTapF(aC, aW, vec2( 0,-1)-pp, dir, len2, lob, clp, bC);
    FsrEasuTapF(aC, aW, vec2( 1,-1)-pp, dir, len2, lob, clp, cC);
    FsrEasuTapF(aC, aW, vec2(-1, 1)-pp, dir, len2, lob, clp, iC);
    FsrEasuTapF(aC, aW, vec2( 0, 1)-pp, dir, len2, lob, clp, jC);
    FsrEasuTapF(aC, aW, vec2( 0, 0)-pp, dir, len2, lob, clp, fC);
    FsrEasuTapF(aC, aW, vec2(-1, 0)-pp, dir, len2, lob, clp, eC);
    FsrEasuTapF(aC, aW, vec2( 1, 1)-pp, dir, len2, lob, clp, kC);
    FsrEasuTapF(aC, aW, vec2( 2, 1)-pp, dir, len2, lob, clp, lC);
    FsrEasuTapF(aC, aW, vec2( 2, 0)-pp, dir, len2, lob, clp, hC);
    FsrEasuTapF(aC, aW, vec2( 1, 0)-pp, dir, len2, lob, clp, gC);
    FsrEasuTapF(aC, aW, vec2( 1, 2)-pp, dir, len2, lob, clp, oC);
    FsrEasuTapF(aC, aW, vec2( 0, 2)-pp, dir, len2, lob, clp, nC);
    //------------------------------------------------------------------------------------------------------------------------------
    // Normalize and dering.
#if (PERFORMANCE == 1)
	pix = aC/aW;
#elif (PERFORMANCE == 0)
    vec3 min4 = min(min(fC,gC),min(jC,kC));
    vec3 max4 = max(max(fC,gC),max(jC,kC));
    pix=min(max4,max(min4,aC/aW));
#endif
}

void EASU( out vec4 fragColor, in vec2 fragCoord )
{
    vec3 c;
    vec4 con0,con1,con2,con3;
    
    // "rendersize" refers to size of source image before upscaling.
    vec2 rendersize = vec2(texWidth, texHeight);
    FsrEasuCon(
        con0, con1, con2, con3, rendersize, rendersize, vec2(width, height)
    );
    FsrEasuF(c, fragCoord, con0, con1, con2, con3);
    
    fragColor = vec4(xyz_to_rgb(c.xyz), 1);
}

vec4 getPixel(vec2 pos) {
	vec2 coord = (pos + .5) / vec2(width, height);
	coord.y = 1.0 - coord.y;
	return texture2D(camTexture, coord);
}

void main() {
	width_half = width / 2.0;
	//vec2 coord = 1.0 - (gl_FragCoord.xy + .5) / vec2(width, height);
	//coord.x = 1.0 - coord.x;
	//vec4 e = texture2D(camTexture, coord);
	vec4 e = getPixel(gl_FragCoord.xy);
	if (gl_FragCoord.x > width_half){
		
		vec4 e_xyz = vec4(rgb_to_xyz(e.rgb), 1);
		EASU(e_xyz, (gl_FragCoord.xy + 0.5) / vec2(width, height));  
		
		// fetch a 3x3 neighborhood around the pixel 'e',
		//  a b c
		//  d(e)f
		//  g h i	
		vec3 a = getPixel(gl_FragCoord.xy + vec2(-1.0,-1.0)).rgb;
		vec3 b = getPixel(gl_FragCoord.xy + vec2( 0.0,-1.0)).rgb;
		vec3 c = getPixel(gl_FragCoord.xy + vec2( 1.0,-1.0)).rgb;
		vec3 f = getPixel(gl_FragCoord.xy + vec2( 1.0, 0.0)).rgb;
		vec3 g = getPixel(gl_FragCoord.xy + vec2(-1.0, 1.0)).rgb;
		vec3 h = getPixel(gl_FragCoord.xy + vec2( 0.0, 1.0)).rgb;
		vec3 d = getPixel(gl_FragCoord.xy + vec2(-1.0, 0.0)).rgb;
		vec3 i = getPixel(gl_FragCoord.xy + vec2( 1.0, 1.0)).rgb;;
		// Soft min and max.
		//  a b c			b
		//  d e f * 0.5	+ d e f * 0.5
		//  g h i			h
		// These are 2.0x bigger (factored out the extra multiply).

		vec3 mnRGB = min(min(min(d, e.rgb), min(f, b)), h);
		vec3 mnRGB2 = min(mnRGB, min(min(a, c), min(g, i)));
		mnRGB += mnRGB2;

		vec3 mxRGB = max(max(max(d, e.rgb), max(f, b)), h);
		vec3 mxRGB2 = max(mxRGB, max(max(a, c), max(g, i)));
		mxRGB += mxRGB2;

		// Smooth minimum distance to signal limit divided by smooth max.
		vec3 rcpMRGB = 1.0 / mxRGB;
		vec3 ampRGB = clamp(min(mnRGB, 2.0 - mxRGB) * rcpMRGB, 0.0, 1.0);

		// Shaping amount of sharpening.
		ampRGB = inversesqrt(ampRGB);

		float peak = -3.0 * clamp(CONTRAST, 0.0, 1.0) + 8.0;
		vec3 wRGB = -(1.0 / (ampRGB * peak));

		vec3 rcpWeightRGB = 1.0 / (4.0 * wRGB + 1.0);

		//					0 w 0
		//  Filter shape:	w 1 w
		//					0 w 0
		vec3 window = (b + d) + (f + h);
		vec3 outColor = clamp((window * wRGB + e.rgb) * rcpWeightRGB, 0.0, 1.0);

		gl_FragColor = vec4(mix(e.rgb, outColor, SHARPENING), e.a);
	}
	else gl_FragColor = e;
	// draw black line to seperate preview
	if (gl_FragCoord.x > width_half - 1.0 && gl_FragCoord.x < width_half + 1.0) gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
}
`

const vert = glsl`
precision mediump float;
attribute vec2 position;

void main () {
  gl_Position = vec4(position, 0, 1.0);
}
`
let direction = localStorage.getItem('direction');
if (direction == null) {
  direction = 'user'
  localStorage.setItem('direction', direction);
}
let video = document.querySelector('video');
let fallbackImage = null;

let camTexture = null;

const glea = new GLea({
  glOptions: {
    preserveDrawingBuffer: true
  },
  shaders: [
    GLea.fragmentShader(frag),
    GLea.vertexShader(vert)
  ],
  buffers: {
    'position': GLea.buffer(2, [1, 1, -1, 1, 1, -1, -1, -1])
  }
}).create();

window.addEventListener('resize', () => {
  glea.resize();
});

const fpsElem = document.querySelector("#fps");
let then = 0;
function loop(time) {
  time *= 0.001;                          // convert to seconds
  const deltaTime = time - then;          // compute time since last frame
  then = time;                            // remember time for next frame
  const fps = 1 / deltaTime;             // compute frames per second
  fpsElem.textContent = fps.toFixed(1);  // update fps display
 
  const { gl } = glea;
  // Upload the image into the texture.
  if (video) {
    glea.setActiveTexture(0, camTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);  
    glea.uni('texWidth', video.videoWidth);
    glea.uni('texHeight', video.videoHeight);
  } else {
    glea.uni('texWidth', 1);
    glea.uni('texHeight', 1);
  }
  
  glea.clear();
  glea.uni('width', glea.width);
  glea.uni('height', glea.height);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  requestAnimationFrame(loop);
}

function accessWebcam(video) {
  return new Promise((resolve, reject) => {
    const mediaConstraints = {
      audio: false, 
      video: { 
        brightness: { ideal: 2 },
        facingMode: { exact: direction },
        width: { ideal: 65536 },
        height: { ideal: 65536 } 
      } 
    };
    navigator.mediaDevices.getUserMedia(mediaConstraints).then(mediaStream => {
      video.srcObject = mediaStream;
      video.setAttribute('playsinline', true);
      video.onloadedmetadata = (e) => {
        video.play();
        resolve(video);
      }
    }).catch(err => {
      reject(err);
    });
  });
}


function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.src = url;
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      reject(img);
    };
  });
}

function takeScreenshot() {
  const { canvas } = glea;
  const anchor = document.createElement('a');
  anchor.setAttribute('download', 'selfie.jpg');
  anchor.setAttribute('href', canvas.toDataURL('image/jpeg', 0.92));
  anchor.click();
}

async function changeDirection() {
  if (direction == 'user') {
    direction = 'environment';
  } else
  {
    direction = 'user'
  }
  localStorage.setItem('direction', direction);
  window.location.href = window.location.href;
}
async function setup() {
  const { gl } = glea;
  try {
    await accessWebcam(video);
  } catch (ex) {
    video = null;
    console.error(ex.message);
  }
  // video = null;
  if (! video) {
    try {
      fallbackImage = await loadImage('https://')
    } catch (ex) {
      console.error(ex.message);
      return false;
    }
  }

  camTexture = glea.createTexture(0);
  // Upload the image into the texture.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video || fallbackImage);
  
  glea.setActiveTexture(0, camTexture);

  glea.uniI('camTexture', 0);
  loop(0);
}

setup();
