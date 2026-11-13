package win32

import (
	"slices"
	"testing"
	"unsafe"
)

func TestCCDLayouts(t *testing.T) {
	if unsafe.Sizeof(sourceName{}) != 84 || unsafe.Sizeof(targetName{}) != 420 || unsafe.Sizeof(colorInfo{}) != 32 || unsafe.Sizeof(monitorInfo{}) != 104 || unsafe.Sizeof(displayDevice{}) != 840 || unsafe.Sizeof(physical{}) != 264 {
		t.Fatal("Windows interop structure layout changed")
	}
}
func TestWarmRampWindowsEnvelope(t *testing.T) {
	original := make([]uint16, 768)
	for c := 0; c < 3; c++ {
		for i := 0; i < 256; i++ {
			original[c*256+i] = uint16(i * 257)
		}
	}
	neutral, err := warmRamp(original, 6500)
	if err != nil || !slices.Equal(neutral, original) {
		t.Fatal("neutral must preserve baseline")
	}
	for _, kelvin := range []int{2700, 3200, 4500, 5600} {
		ramp, err := warmRamp(original, kelvin)
		if err != nil {
			t.Fatal(err)
		}
		for c := 0; c < 3; c++ {
			for i := 0; i < 256; i++ {
				v := int(ramp[c*256+i])
				if abs(v-i*257) > 32768 {
					t.Fatalf("outside Windows envelope: %dK", kelvin)
				}
				if i > 0 && ramp[c*256+i] < ramp[c*256+i-1] {
					t.Fatal("nonmonotonic ramp")
				}
			}
		}
		if slices.Equal(ramp, original) {
			t.Fatal("warm target must change table")
		}
	}
	if _, err := warmRamp(original[:767], 4500); err == nil {
		t.Fatal("invalid length accepted")
	}
}
