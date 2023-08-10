import React from 'react';
import GettingStartedProgress from 'Shared/GettingStarted/GettingStartedProgress';
import Notifications from 'Components/Alerts/Notifications/Notifications';
import cn from 'classnames';
import styles from 'Components/Header/header.module.css';
import { Icon, Tooltip } from 'UI';
import { NavLink } from 'react-router-dom';
import SettingsMenu from 'Components/Header/SettingsMenu/SettingsMenu';
import HealthStatus from 'Components/Header/HealthStatus';
import { getInitials } from 'App/utils';
import UserMenu from 'Components/Header/UserMenu/UserMenu';
import ErrorGenPanel from 'App/dev/components/ErrorGenPanel';
import { client, CLIENT_DEFAULT_TAB } from 'App/routes';
import { connect } from 'react-redux';
import { Menu, MenuProps, Popover, Space } from 'antd';
import { Button } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import ProjectDropdown from 'Shared/ProjectDropdown';

const CLIENT_PATH = client(CLIENT_DEFAULT_TAB);

const items: MenuProps['items'] = [
  { key: '1', label: 'nav 1' },
  { key: '2', label: 'nav 2' }
];

interface Props {
  account: any;
  siteId: any;
  sites: any;
  boardingCompletion: any;
}

function TopRight(props: Props) {
  const { account } = props;
  // @ts-ignore
  return (
    // <Menu mode='horizontal' defaultSelectedKeys={['2']} items={items}
    //       style={{ height: '50px' }}
    //       className='bg-gray-lightest' />
    <Space className='flex items-center'>
      <ProjectDropdown />
      <GettingStartedProgress />

      <Notifications />

      <HealthStatus />

      <Popover content={<UserMenu className='' />} placement={'topRight'}>
        <div className='flex items-center cursor-pointer'>
          <div className='w-10 h-10 bg-tealx rounded-full flex items-center justify-center color-white'>
            {getInitials(account.name)}
          </div>
        </div>
      </Popover>

      <ErrorGenPanel />
    </Space>
  );
}

function mapStateToProps(state: any) {
  return {
    account: state.getIn(['user', 'account']),
    siteId: state.getIn(['site', 'siteId']),
    sites: state.getIn(['site', 'list']),
    boardingCompletion: state.getIn(['dashboard', 'boardingCompletion'])
  };
}

export default connect(mapStateToProps)(TopRight);