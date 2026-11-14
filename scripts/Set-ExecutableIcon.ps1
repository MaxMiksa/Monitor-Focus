param([Parameter(Mandatory)][string]$Executable)
$ErrorActionPreference='Stop'
if(-not ('MonitorsFocusResources' -as [type])) {
Add-Type @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class MonitorsFocusResources {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr BeginUpdateResource(string file,bool delete);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateResource(IntPtr update,IntPtr type,IntPtr name,ushort language,byte[] data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool EndUpdateResource(IntPtr update,bool discard);
 static void Put(IntPtr h,int type,int id,byte[] data) {if(!UpdateResource(h,(IntPtr)type,(IntPtr)id,0,data,(uint)data.Length))throw new Win32Exception();}
 static void Icon(IntPtr h,string file,int group,int start) {
  using(var r=new BinaryReader(File.OpenRead(file))) using(var m=new MemoryStream()) using(var w=new BinaryWriter(m)) {
   if(r.ReadUInt16()!=0 || r.ReadUInt16()!=1)throw new InvalidDataException("Invalid ICO");
   ushort count=r.ReadUInt16(); if(count==0 || count>32)throw new InvalidDataException("Invalid ICO count");
   w.Write((ushort)0);w.Write((ushort)1);w.Write(count);
   for(int i=0;i<count;i++) {
    r.BaseStream.Position=6+16*i;byte[] header=r.ReadBytes(12);uint offset=r.ReadUInt32();uint size=BitConverter.ToUInt32(header,8);
    if(offset+size>r.BaseStream.Length)throw new InvalidDataException("Invalid ICO frame");
    r.BaseStream.Position=offset;byte[] image=r.ReadBytes((int)size);Put(h,3,start+i,image);w.Write(header);w.Write((ushort)(start+i));
   }
   Put(h,14,group,m.ToArray());
  }
 }
 public static void Apply(string exe,string black,string white) {
  IntPtr h=BeginUpdateResource(exe,false);if(h==IntPtr.Zero)throw new Win32Exception();bool complete=false;
  try{Icon(h,black,32512,1);Icon(h,white,32513,101);complete=true;}
  finally{if(!EndUpdateResource(h,!complete))throw new Win32Exception();}
 }
}
'@
}
$assetRoot=Join-Path (Split-Path $PSScriptRoot -Parent) 'frontend/public'
[MonitorsFocusResources]::Apply((Resolve-Path -LiteralPath $Executable).Path,(Join-Path $assetRoot 'app.ico'),(Join-Path $assetRoot 'app-white.ico'))
