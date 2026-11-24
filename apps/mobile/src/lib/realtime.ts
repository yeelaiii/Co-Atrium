let seq = 0;

/**
 * A Realtime channel name unique to one subscriber. `supabase.channel(name)` returns the
 * existing channel when the name is already in use, and adding `.on()` to an already
 * subscribed channel throws. Stacked screens often run the same hook for the same project,
 * so every subscriber gets its own channel.
 */
export function channelName(base: string) {
  seq += 1;
  return `${base}#${seq}`;
}
