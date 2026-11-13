package desktop

func matchesFullscreen(a, b Rect) bool {
	for _, pair := range [][2]int32{{a.Left, b.Left}, {a.Top, b.Top}, {a.Right, b.Right}, {a.Bottom, b.Bottom}} {
		d := int64(pair[0]) - int64(pair[1])
		if d < -2 || d > 2 {
			return false
		}
	}
	return a.valid() && b.valid()
}
