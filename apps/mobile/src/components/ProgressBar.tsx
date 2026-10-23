import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

type Props = { step: number; total: number };

// Flat track with an accent fill; `step` is the 1-based current step.
export function ProgressBar({ step, total }: Props) {
  const progress = useSharedValue(step / total);

  useEffect(() => {
    progress.value = withTiming(step / total, { duration: 250 });
  }, [step, total, progress]);

  const fill = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${step} of ${total}`}
      accessibilityValue={{ min: 0, max: total, now: step }}
      className="h-1.5 overflow-hidden rounded-full bg-border dark:bg-border-dark">
      <Animated.View className="h-full rounded-full bg-accent dark:bg-accent-dark" style={fill} />
    </View>
  );
}
