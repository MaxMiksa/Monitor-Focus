//go:build windows

package main

import "testing"

func TestSizingPreservesRatioAndOppositeEdge(t *testing.T) {
	for edge := uintptr(1); edge <= 8; edge++ {
		original := ratioRect{100, 200, 1316, 929}
		got := constrainSizingRect(original, edge, 16, 39, 736, 2576)
		width, height := int64(got.Right-got.Left)-16, int64(got.Bottom-got.Top)-39
		if width != 1200 && edge != wmszTop && edge != wmszBottom {
			t.Errorf("edge %d discarded horizontal resize: %d", edge, width)
		}
		if absRatioError(width, height) > 16 {
			t.Errorf("edge %d ratio mismatch: %dx%d", edge, width, height)
		}
		if (edge == 1 || edge == 4 || edge == 7) && got.Right != original.Right {
			t.Errorf("edge %d moved opposite right edge", edge)
		}
		if (edge == 3 || edge == 4 || edge == 5) && got.Bottom != original.Bottom {
			t.Errorf("edge %d moved opposite bottom edge", edge)
		}
	}
}

func TestSizingClampsClientWidth(t *testing.T) {
	for _, width := range []int32{100, 4000} {
		got := constrainSizingRect(ratioRect{Right: width, Bottom: 600}, 2, 16, 39, 736, 2576)
		want := int32(736)
		if width > 2576 {
			want = 2576
		}
		if got.Right-got.Left != want {
			t.Fatalf("width %d: %+v", width, got)
		}
	}
}
