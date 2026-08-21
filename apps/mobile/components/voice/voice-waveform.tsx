/**
 * Wavelength bars shown while the user is speaking or Whisper is
 * transcribing. Live `level` (0–1) drives amplitude during recording;
 * without a level we loop a soft idle wave.
 */
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";

const BAR_COUNT = 22;
const BAR_WIDTH = 3;
const MAX_HEIGHT = 36;
const MIN_HEIGHT = 4;

interface Props {
  active: boolean;
  /** Normalized 0–1 microphone level. Omit for a looping idle wave. */
  level?: number;
}

export function VoiceWaveform({ active, level }: Props) {
  const { colorScheme } = useColorScheme();
  const tint = THEME[colorScheme].brand;
  const clock = useSharedValue(0);
  const amplitude = useSharedValue(0.35);

  useEffect(() => {
    if (!active) {
      cancelAnimation(clock);
      clock.value = 0;
      amplitude.value = withTiming(0.08, { duration: 180 });
      return;
    }
    clock.value = withRepeat(
      withTiming(Math.PI * 2, { duration: 900, easing: Easing.linear }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(clock);
    };
  }, [active, clock, amplitude]);

  useEffect(() => {
    if (!active) return;
    if (level == null) {
      amplitude.value = withTiming(0.55, { duration: 200 });
      return;
    }
    amplitude.value = withTiming(Math.max(0.12, Math.min(1, level)), {
      duration: 70,
    });
  }, [active, level, amplitude]);

  if (!active) return null;

  return (
    <View
      className="h-10 flex-row items-center justify-center gap-0.5"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <WaveBar
          key={index}
          index={index}
          clock={clock}
          amplitude={amplitude}
          color={tint}
        />
      ))}
    </View>
  );
}

function WaveBar({
  index,
  clock,
  amplitude,
  color,
}: {
  index: number;
  clock: SharedValue<number>;
  amplitude: SharedValue<number>;
  color: string;
}) {
  const phase = (index / BAR_COUNT) * Math.PI * 2;
  const weight = 0.45 + 0.55 * Math.sin((index / (BAR_COUNT - 1)) * Math.PI);

  const style = useAnimatedStyle(() => {
    const wave = 0.35 + 0.65 * Math.abs(Math.sin(clock.value + phase));
    const height = MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * amplitude.value * wave * weight;
    return {
      height,
      backgroundColor: color,
    };
  });

  return (
    <Animated.View
      style={[
        {
          width: BAR_WIDTH,
          borderRadius: 999,
        },
        style,
      ]}
    />
  );
}
