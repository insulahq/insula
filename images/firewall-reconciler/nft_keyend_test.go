package main

import (
	"net/netip"
	"reflect"
	"testing"

	"github.com/google/nftables"
)

// These tests cover the read/write interval-set encoding asymmetry behind
// #129: the reconciler WRITES the legacy paired-IntervalEnd shape, but the
// kernel normalises interval sets and returns the modern single-element
// KeyEnd shape (Key=start, KeyEnd=end-exclusive) on read. The decoders must
// understand BOTH; the original read-only-IntervalEnd code returned [] for a
// populated set read back from the kernel, so observe matched the empty
// desired set and the REMOVE tick never flushed.

func keyEnd(start, endExcl uint16) nftables.SetElement {
	return nftables.SetElement{Key: portBytes(start), KeyEnd: portBytes(endExcl)}
}

func TestDecodePortElements_KeyEndShape(t *testing.T) {
	cases := []struct {
		name  string
		elems []nftables.SetElement
		want  []string
	}{
		{"single port", []nftables.SetElement{keyEnd(3478, 3479)}, []string{"3478"}},
		{"two singles", []nftables.SetElement{keyEnd(3478, 3479), keyEnd(5349, 5350)}, []string{"3478", "5349"}},
		{"range", []nftables.SetElement{keyEnd(8000, 8010)}, []string{"8000-8009"}},
		{"wraparound hi=65535", []nftables.SetElement{keyEnd(1024, 0)}, []string{"1024-65535"}},
		{"empty set", []nftables.SetElement{}, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decodePortElements(tc.elems)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("decodePortElements = %v, want %v", got, tc.want)
			}
		})
	}
}

// The #129 regression in one assertion: a populated set read back in the
// KeyEnd shape must NOT decode to empty (which is what defeated the
// observe-vs-desired short-circuit on the remove path).
func TestDecodePortElements_PopulatedKeyEndIsNotEmpty(t *testing.T) {
	got := decodePortElements([]nftables.SetElement{keyEnd(3478, 3479), keyEnd(5349, 5350)})
	if len(got) == 0 {
		t.Fatal("populated KeyEnd-shaped set decoded to EMPTY — observe would short-circuit the remove flush (#129)")
	}
}

// The legacy paired-IntervalEnd shape (what portsToElements writes, and what
// older kernels may return) must keep decoding correctly — no regression.
func TestDecodePortElements_LegacyIntervalEndStillWorks(t *testing.T) {
	got := decodePortElements(portsToElements([]string{"3478", "5349", "8000-8009"}))
	want := []string{"3478", "5349", "8000-8009"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("legacy IntervalEnd round-trip = %v, want %v", got, want)
	}
}

func TestDecodeAddrElements_KeyEndShape(t *testing.T) {
	ip := netip.MustParseAddr("10.0.0.5")
	elems := []nftables.SetElement{{Key: addrBytes(ip, false), KeyEnd: addrBytes(ip.Next(), false)}}
	got := decodeAddrElements(elems, false)
	if !reflect.DeepEqual(got, []string{"10.0.0.5"}) {
		t.Fatalf("decodeAddrElements = %v, want [10.0.0.5]", got)
	}
}

func TestDecodeCidrElements_KeyEndShape(t *testing.T) {
	start := netip.MustParseAddr("10.0.0.0")
	end := netip.MustParseAddr("10.0.1.0") // [10.0.0.0, 10.0.1.0) == /24
	elems := []nftables.SetElement{{Key: addrBytes(start, false), KeyEnd: addrBytes(end, false)}}
	got := decodeCidrElements(elems, false)
	if !reflect.DeepEqual(got, []string{"10.0.0.0/24"}) {
		t.Fatalf("decodeCidrElements = %v, want [10.0.0.0/24]", got)
	}
}
