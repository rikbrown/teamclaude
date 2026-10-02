import type { ClientModule } from 'claude-code'

import type { Segment } from '../types'

type Props = { segments: Segment[] }
type State = { isHover: boolean }

// The footer readout as one clickable region: a left click posts `toggle` to
// the hooks module, and the pointer over it underlines it.
const Readout: ClientModule<Props, State> = (props, surface) => {
  surface.onPointer(event => {
    if (event.type === 'down' && event.button === 'left') {
      surface.post({ toggle: true })
    } else if (event.type === 'enter' || event.type === 'leave') {
      surface.setState({ isHover: event.type === 'enter' })
    }
  })
  const { Text } = surface.elements
  const isHover = surface.state?.isHover === true

  return (
    <Text wrap="truncate">
      {props.segments.map(segment => (
        <Text
          {...(segment.color ? { color: segment.color } : { dimColor: segment.isDim })}
          underline={isHover}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  )
}

export default Readout
