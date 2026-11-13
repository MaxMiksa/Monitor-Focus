package main

import (
	"runtime"
	"runtime/debug"
	"sort"
	"unsafe"

	"golang.org/x/sys/windows"
)

type processMemoryCounters struct {
	Size, PageFaultCount                               uint32
	PeakWorkingSetSize, WorkingSetSize                 uintptr
	QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage       uintptr
	QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage uintptr
	PagefileUsage, PeakPagefileUsage, PrivateUsage     uintptr
}

// Diagnostics are available only through the authenticated local pipe. They do
// not trim the working set, enumerate other processes, or touch hardware.
func memoryDiagnostics(reclaim bool) (map[string]any, error) {
	if reclaim {
		debug.FreeOSMemory()
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	p := processMemoryCounters{}
	p.Size = uint32(unsafe.Sizeof(p))
	r, _, err := windows.NewLazySystemDLL("psapi.dll").NewProc("GetProcessMemoryInfo").Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&p)), uintptr(p.Size))
	if r == 0 {
		return nil, err
	}
	type allocation struct {
		Base      uintptr
		Committed uint64
	}
	allocations := map[uintptr]uint64{}
	var private, image, mapped uint64
	for address := uintptr(0); ; {
		var region windows.MemoryBasicInformation
		if err := windows.VirtualQuery(address, &region, unsafe.Sizeof(region)); err != nil {
			if err == windows.ERROR_INVALID_PARAMETER {
				break
			}
			return nil, err
		}
		if region.State == windows.MEM_COMMIT {
			switch region.Type {
			case 0x20000: // MEM_PRIVATE
				private += uint64(region.RegionSize)
				allocations[region.AllocationBase] += uint64(region.RegionSize)
			case 0x1000000: // MEM_IMAGE
				image += uint64(region.RegionSize)
			case 0x40000: // MEM_MAPPED
				mapped += uint64(region.RegionSize)
			}
		}
		next := region.BaseAddress + region.RegionSize
		if next <= address {
			break
		}
		address = next
	}
	largest := make([]allocation, 0, len(allocations))
	for base, committed := range allocations {
		largest = append(largest, allocation{base, committed})
	}
	sort.Slice(largest, func(i, j int) bool { return largest[i].Committed > largest[j].Committed })
	if len(largest) > 12 {
		largest = largest[:12]
	}
	return map[string]any{
		"PrivateBytes": p.PrivateUsage, "WorkingSet": p.WorkingSetSize,
		"GoRuntimeBytes": m.Sys - m.HeapReleased, "GoSys": m.Sys,
		"GoHeapAlloc": m.HeapAlloc, "GoHeapInuse": m.HeapInuse,
		"GoHeapIdle": m.HeapIdle, "GoHeapReleased": m.HeapReleased,
		"GoStackSys": m.StackSys, "GoGCSys": m.GCSys, "GoOtherSys": m.OtherSys,
		"Goroutines": runtime.NumGoroutine(), "NumGC": m.NumGC,
		"PrivateCommittedRegions": private, "ImageCommittedRegions": image,
		"MappedCommittedRegions": mapped, "LargestPrivateAllocations": largest,
		"Reclaimed": reclaim,
	}, nil
}
