# Builds the fore-edge strips, cover crop and textures in assets/ from the film frames. Run with Python 3 + Pillow.
import random, math
from PIL import Image, ImageFilter, ImageChops, ImageOps
import os
ROOT=os.path.dirname(os.path.abspath(__file__))
SRC=os.path.join(ROOT,'../../../apps/preview/public/media/film/')
OUT=os.path.join(ROOT,'assets/')
N=52
frames=[Image.open(SRC+'frames/f-%02d.webp'%i).convert('RGB') for i in range(N)]
CREAM=(236,228,212)
def mix(c,d,t): return tuple(int(round(a*(1-t)+b*t)) for a,b in zip(c,d))
import colorsys
def sat(c,k=1.75):
    h,l,s=colorsys.rgb_to_hls(*[v/255 for v in c]); return tuple(int(v*255) for v in colorsys.hls_to_rgb(h,l,min(1,s*k)))

# 1. Rest fore-edge: one row band per page, colour along length = frame's column profile.
W=1760; ROW=4
im=Image.new('RGB',(W,N*ROW))
for i,f in enumerate(frames):
    prof=f.crop((0,int(f.height*0.5),f.width,int(f.height*0.92))).resize((W,1),Image.BOX).load()
    jit=random.Random(i).randint(-3,3)
    for x in range(W):
        c=prof[min(W-1,max(0,x+jit)),0]
        c=sat(mix(c,CREAM,0.06))
        im.putpixel((x,i*ROW+0), mix(c,(255,250,240),0.22))
        im.putpixel((x,i*ROW+1), c)
        im.putpixel((x,i*ROW+2), tuple(int(v*0.93) for v in c))
        im.putpixel((x,i*ROW+3), tuple(int(v*0.58) for v in c))
im.save(OUT+'edge-rest.png')

# 2. Playing fore-edge: one vertical sliver per page, a centred crop of its own frame.
SW,SH=48,72  # per page at 2x
strip=Image.new('RGB',(SW*N,SH))
for i,f in enumerate(frames):
    h=SH; w=int(f.width*h/f.height)
    s=f.resize((w,h),Image.LANCZOS)
    cx=w//2
    strip.paste(s.crop((cx-SW//2,0,cx+SW//2,h)),(i*SW,0))
strip.save(OUT+'edge-play.png')

# 3. Cover photo, panoramic crop of the poster.
p=Image.open(SRC+'poster.webp').convert('RGB')
pw,ph=p.size; cw=pw; chh=int(pw/2.05)
top=int(ph*0.0)
p.crop((0,top,cw,top+chh)).resize((1600,int(1600/2.05)),Image.LANCZOS).save(OUT+'cover.jpg',quality=90)
p.save(OUT+'poster.jpg',quality=90)
frames[16].save(OUT+'f-16.jpg',quality=92)
for i in ():
    frames[i].save(OUT+'f-%02d.jpg'%i,quality=88)

# 4. Grain (tileable), for the desk and the paper.
def grain(size,seed,amp):
    r=random.Random(seed); g=Image.new('L',(size,size))
    g.putdata([128+int(r.gauss(0,amp)) for _ in range(size*size)])
    return g
g=grain(256,1,22).filter(ImageFilter.GaussianBlur(0.6))
Image.merge('LA',(g,Image.new('L',g.size,255))).save(OUT+'grain.png')
# Paper fibre: stretched noise
f=grain(256,2,30).resize((256,64)).resize((256,256),Image.BICUBIC).filter(ImageFilter.GaussianBlur(0.4))
f=ImageOps.autocontrast(f)
Image.merge('LA',(f,Image.new('L',f.size,255))).save(OUT+'fibre.png')
print('ok')
